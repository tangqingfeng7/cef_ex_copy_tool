#include "pch.h"
#include "ai_native_proxy.h"
#include "ai_config.h"
#include "instance_hooks.h"

#include <winhttp.h>
#include <atomic>
#include <algorithm>
#include <cstring>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "include/capi/cef_callback_capi.h"
#include "include/capi/cef_resource_handler_capi.h"
#include "include/capi/cef_resource_request_handler_capi.h"

namespace {

constexpr wchar_t kProxyPrefix[] = L"/__cef_cx_ai_proxy__/";
constexpr wchar_t kHealthPath[] = L"/__cef_cx_ai_proxy__/health";
constexpr wchar_t kChatPath[] = L"/__cef_cx_ai_proxy__/chat/completions";
constexpr wchar_t kConfigPath[] = L"/__cef_cx_ai_proxy__/config";
constexpr size_t kMaxRequestBytes = 12u * 1024u * 1024u;
constexpr size_t kMaxResponseBytes = 16u * 1024u * 1024u;

using CefUserfreeFree = void (*)(cef_string_userfree_utf16_t);

CefUserfreeFree UserfreeFree() {
    static auto fn = reinterpret_cast<CefUserfreeFree>(
        GetProcAddress(GetModuleHandleW(L"libcef.dll"), "cef_string_userfree_utf16_free"));
    return fn;
}

std::wstring TakeUserfree(cef_string_userfree_t value) {
    std::wstring result;
    if (value && value->str && value->length)
        result.assign(reinterpret_cast<const wchar_t*>(value->str), value->length);
    if (value) {
        if (auto freeFn = UserfreeFree()) freeFn(value);
        else if (value->dtor) value->dtor(value->str);
    }
    return result;
}

cef_string_t CefView(const std::wstring& value) {
    cef_string_t result{};
    result.str = reinterpret_cast<char16*>(const_cast<wchar_t*>(value.data()));
    result.length = value.size();
    return result;
}

bool EndsWithInsensitive(const std::wstring& value, const std::wstring& suffix) {
    if (value.size() < suffix.size()) return false;
    return _wcsicmp(value.c_str() + value.size() - suffix.size(), suffix.c_str()) == 0;
}

struct ParsedUrl {
    bool valid = false;
    bool secure = false;
    INTERNET_PORT port = 0;
    std::wstring host;
    std::wstring path;
};

ParsedUrl ParseUrl(const std::wstring& url) {
    URL_COMPONENTS parts{};
    parts.dwStructSize = sizeof(parts);
    parts.dwSchemeLength = static_cast<DWORD>(-1);
    parts.dwHostNameLength = static_cast<DWORD>(-1);
    parts.dwUrlPathLength = static_cast<DWORD>(-1);
    parts.dwExtraInfoLength = static_cast<DWORD>(-1);
    parts.dwUserNameLength = static_cast<DWORD>(-1);
    parts.dwPasswordLength = static_cast<DWORD>(-1);
    ParsedUrl result;
    if (!WinHttpCrackUrl(url.c_str(), static_cast<DWORD>(url.size()), 0, &parts)) return result;
    if (parts.dwUserNameLength || parts.dwPasswordLength) return result;
    result.valid = true;
    result.secure = parts.nScheme == INTERNET_SCHEME_HTTPS;
    result.port = parts.nPort;
    result.host.assign(parts.lpszHostName, parts.dwHostNameLength);
    result.path.assign(parts.lpszUrlPath, parts.dwUrlPathLength);
    if (parts.dwExtraInfoLength) result.path.append(parts.lpszExtraInfo, parts.dwExtraInfoLength);
    return result;
}

bool AllowedExamHost(const std::wstring& host) {
    return _wcsicmp(host.c_str(), L"chaoxing.com") == 0 ||
        EndsWithInsensitive(host, L".chaoxing.com") || EndsWithInsensitive(host, L".edu.cn");
}

enum class ProxyRoute { None, Health, Chat, Config };

ProxyRoute RouteForPath(const std::wstring& path) {
    if (path == kHealthPath) return ProxyRoute::Health;
    if (path == kChatPath) return ProxyRoute::Chat;
    if (path == kConfigPath) return ProxyRoute::Config;
    return ProxyRoute::None;
}

bool IsProxyRoute(const std::wstring& requestUrl, const std::wstring& initiator,
                  const std::wstring& method) {
    const auto request = ParseUrl(requestUrl);
    const auto source = ParseUrl(initiator);
    if (!request.valid || !source.valid || !request.secure || !source.secure) return false;
    if (_wcsicmp(request.host.c_str(), source.host.c_str()) != 0 || !AllowedExamHost(source.host)) return false;
    const auto route = RouteForPath(request.path);
    if (route == ProxyRoute::Health) return _wcsicmp(method.c_str(), L"GET") == 0;
    return (route == ProxyRoute::Chat || route == ProxyRoute::Config) &&
        _wcsicmp(method.c_str(), L"POST") == 0;
}

bool IsAllowedTarget(const std::wstring& target) {
    const auto url = ParseUrl(target);
    if (!url.valid || !url.secure || url.port != INTERNET_DEFAULT_HTTPS_PORT) return false;
    if (_wcsicmp(url.host.c_str(), L"api.deepseek.com") != 0) return false;
    return url.path == L"/chat/completions" || url.path == L"/v1/chat/completions";
}

std::wstring Header(cef_request_t* request, const wchar_t* name) {
    if (!request || !request->get_header_by_name) return {};
    const std::wstring key(name);
    auto view = CefView(key);
    return TakeUserfree(request->get_header_by_name(request, &view));
}

std::vector<unsigned char> PostBody(cef_request_t* request) {
    std::vector<unsigned char> body;
    if (!request || !request->get_post_data) return body;
    auto* post = request->get_post_data(request);
    if (!post) return body;
    const size_t count = post->get_element_count ? post->get_element_count(post) : 0;
    if (count && count <= 8 && post->get_elements) {
        std::vector<cef_post_data_element_t*> elements(count, nullptr);
        size_t actual = count;
        post->get_elements(post, &actual, elements.data());
        for (size_t i = 0; i < actual && body.size() <= kMaxRequestBytes; ++i) {
            auto* element = elements[i];
            if (element && element->get_type && element->get_type(element) == PDE_TYPE_BYTES &&
                element->get_bytes_count && element->get_bytes) {
                const size_t bytes = element->get_bytes_count(element);
                if (bytes > kMaxRequestBytes - body.size()) body.resize(kMaxRequestBytes + 1);
                else {
                    const size_t old = body.size();
                    body.resize(old + bytes);
                    if (element->get_bytes(element, bytes, body.data() + old) != bytes)
                        body.resize(kMaxRequestBytes + 1);
                }
            } else body.resize(kMaxRequestBytes + 1);
            if (element && element->base.release) element->base.release(&element->base);
        }
    }
    if (post->base.release) post->base.release(&post->base);
    return body;
}

struct ProxyResourceHandler {
    cef_resource_handler_t api{};
    std::atomic<long> refs{1};
    std::atomic<bool> canceled{false};
    std::mutex mutex;
    HINTERNET activeRequest = nullptr;
    std::vector<unsigned char> response;
    size_t offset = 0;
    int status = 502;
    DWORD winError = ERROR_SUCCESS;
    ProxyRoute route = ProxyRoute::None;

    explicit ProxyResourceHandler(ProxyRoute routeKind) : route(routeKind) {
        api.base.size = sizeof(api);
        api.base.add_ref = AddRef;
        api.base.release = Release;
        api.base.has_one_ref = HasOneRef;
        api.base.has_at_least_one_ref = HasAtLeastOneRef;
        api.open = Open;
        api.get_response_headers = GetResponseHeaders;
        api.skip = Skip;
        api.read = Read;
        api.cancel = Cancel;
        if (route == ProxyRoute::Health) {
            status = 200;
            const char marker[] = "{\"cefCxAiProxy\":1}";
            response.assign(marker, marker + sizeof(marker) - 1);
        }
    }

    static ProxyResourceHandler* Self(cef_base_ref_counted_t* base) {
        return reinterpret_cast<ProxyResourceHandler*>(base);
    }
    static ProxyResourceHandler* Self(cef_resource_handler_t* api) {
        return reinterpret_cast<ProxyResourceHandler*>(api);
    }
    static void CEF_CALLBACK AddRef(cef_base_ref_counted_t* base) { ++Self(base)->refs; }
    static int CEF_CALLBACK Release(cef_base_ref_counted_t* base) {
        auto* self = Self(base);
        if (--self->refs != 0) return 0;
        delete self;
        return 1;
    }
    static int CEF_CALLBACK HasOneRef(cef_base_ref_counted_t* base) { return Self(base)->refs.load() == 1; }
    static int CEF_CALLBACK HasAtLeastOneRef(cef_base_ref_counted_t* base) { return Self(base)->refs.load() > 0; }

    void SetError(DWORD error) {
        status = 502;
        winError = error;
        const std::string json = "{\"cefCxProxyError\":{\"win32\":" + std::to_string(error) + "}}";
        response.assign(json.begin(), json.end());
    }

    void Perform(std::wstring target, std::wstring key, std::vector<unsigned char> body, DWORD timeoutMs) {
        const auto url = ParseUrl(target);
        HINTERNET session = WinHttpOpen(L"cef-cx-copy-tool/1.0", WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
            WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
        if (!session) { SetError(GetLastError()); return; }
        WinHttpSetTimeouts(session, timeoutMs, timeoutMs, timeoutMs, timeoutMs);
        HINTERNET connect = WinHttpConnect(session, url.host.c_str(), url.port, 0);
        if (!connect) { const DWORD e = GetLastError(); WinHttpCloseHandle(session); SetError(e); return; }
        HINTERNET request = WinHttpOpenRequest(connect, L"POST", url.path.c_str(), nullptr,
            WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, WINHTTP_FLAG_SECURE);
        if (!request) {
            const DWORD e = GetLastError(); WinHttpCloseHandle(connect); WinHttpCloseHandle(session); SetError(e); return;
        }
        {
            std::lock_guard<std::mutex> lock(mutex);
            if (canceled.load()) { WinHttpCloseHandle(request); WinHttpCloseHandle(connect); WinHttpCloseHandle(session); return; }
            activeRequest = request;
        }
        DWORD redirectPolicy = WINHTTP_OPTION_REDIRECT_POLICY_NEVER;
        WinHttpSetOption(request, WINHTTP_OPTION_REDIRECT_POLICY, &redirectPolicy, sizeof(redirectPolicy));
        const std::wstring headers = L"Content-Type: application/json\r\nAuthorization: Bearer " + key + L"\r\n";
        BOOL ok = WinHttpSendRequest(request, headers.c_str(), static_cast<DWORD>(-1L),
            body.empty() ? WINHTTP_NO_REQUEST_DATA : body.data(), static_cast<DWORD>(body.size()),
            static_cast<DWORD>(body.size()), 0) && WinHttpReceiveResponse(request, nullptr);
        if (ok) {
            DWORD code = 0, size = sizeof(code);
            ok = WinHttpQueryHeaders(request, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                WINHTTP_HEADER_NAME_BY_INDEX, &code, &size, WINHTTP_NO_HEADER_INDEX);
            if (ok) status = static_cast<int>(code);
        }
        std::vector<unsigned char> data;
        while (ok && !canceled.load()) {
            DWORD available = 0;
            if (!WinHttpQueryDataAvailable(request, &available)) { ok = FALSE; break; }
            if (!available) break;
            if (available > kMaxResponseBytes - data.size()) { SetError(ERROR_INSUFFICIENT_BUFFER); ok = FALSE; break; }
            const size_t old = data.size();
            data.resize(old + available);
            DWORD read = 0;
            if (!WinHttpReadData(request, data.data() + old, available, &read)) { ok = FALSE; break; }
            data.resize(old + read);
        }
        const DWORD error = ok ? ERROR_SUCCESS : GetLastError();
        bool closeRequest = false;
        {
            std::lock_guard<std::mutex> lock(mutex);
            closeRequest = activeRequest == request;
            activeRequest = nullptr;
        }
        if (closeRequest) WinHttpCloseHandle(request);
        WinHttpCloseHandle(connect);
        WinHttpCloseHandle(session);
        if (canceled.load()) return;
        if (!ok) SetError(error ? error : ERROR_GEN_FAILURE);
        else response.swap(data);
    }

    static int CEF_CALLBACK Open(cef_resource_handler_t* api, cef_request_t* request,
                                 int* handleRequest, cef_callback_t* callback) {
        auto* self = Self(api);
        if (!handleRequest) return 0;
        if (self->status == 200 && !self->response.empty()) { *handleRequest = 1; return 1; }
        if (self->route == ProxyRoute::Config) {
            auto body = PostBody(request);
            const bool saved = !body.empty() && body.size() <= 65536 &&
                SaveAiConfigFile(std::string(body.begin(), body.end()));
            self->status = saved ? 200 : 500;
            const char* json = saved ? "{\"saved\":true}" : "{\"saved\":false}";
            self->response.assign(json, json + strlen(json));
            *handleRequest = 1;
            return 1;
        }
        const std::wstring target = Header(request, L"X-Cef-Cx-Ai-Target");
        const std::wstring key = Header(request, L"X-Cef-Cx-Ai-Key");
        const std::wstring timeoutText = Header(request, L"X-Cef-Cx-Ai-Timeout");
        auto body = PostBody(request);
        DWORD timeoutMs = 90000;
        if (!timeoutText.empty()) {
            wchar_t* end = nullptr;
            const unsigned long parsed = wcstoul(timeoutText.c_str(), &end, 10);
            if (end && !*end && parsed >= 5000 && parsed <= 180000) timeoutMs = parsed;
        }
        if (!IsAllowedTarget(target) || key.empty() || key.size() > 8192 || body.empty() || body.size() > kMaxRequestBytes) {
            self->status = 400;
            const char invalid[] = "{\"cefCxProxyError\":{\"code\":\"INVALID_REQUEST\"}}";
            self->response.assign(invalid, invalid + sizeof(invalid) - 1);
            *handleRequest = 1;
            return 1;
        }
        *handleRequest = 0;
        if (callback->base.add_ref) callback->base.add_ref(&callback->base);
        AddRef(&self->api.base);
        try {
            std::thread([self, callback, target, key, body = std::move(body), timeoutMs]() mutable {
                self->Perform(target, key, std::move(body), timeoutMs);
                if (!self->canceled.load() && callback->cont) callback->cont(callback);
                if (callback->base.release) callback->base.release(&callback->base);
                Release(&self->api.base);
            }).detach();
        } catch (...) {
            if (callback->base.release) callback->base.release(&callback->base);
            Release(&self->api.base);
            self->SetError(ERROR_NOT_ENOUGH_MEMORY);
            *handleRequest = 1;
        }
        return 1;
    }

    static void CEF_CALLBACK GetResponseHeaders(cef_resource_handler_t* api, cef_response_t* response,
                                                int64* responseLength, cef_string_t*) {
        auto* self = Self(api);
        if (response->set_status) response->set_status(response, self->status);
        if (response->set_mime_type) {
            const std::wstring mime = L"application/json";
            auto value = CefView(mime);
            response->set_mime_type(response, &value);
        }
        if (responseLength) *responseLength = static_cast<int64>(self->response.size());
    }

    static int CEF_CALLBACK Skip(cef_resource_handler_t* api, int64 bytesToSkip, int64* bytesSkipped,
                                 cef_resource_skip_callback_t*) {
        auto* self = Self(api);
        const size_t remaining = self->response.size() - (std::min)(self->offset, self->response.size());
        const size_t count = static_cast<size_t>((std::min)(bytesToSkip, static_cast<int64>(remaining)));
        self->offset += count;
        if (bytesSkipped) *bytesSkipped = static_cast<int64>(count);
        return count > 0;
    }

    static int CEF_CALLBACK Read(cef_resource_handler_t* api, void* output, int bytesToRead,
                                 int* bytesRead, cef_resource_read_callback_t*) {
        auto* self = Self(api);
        if (!bytesRead || !output || bytesToRead <= 0) return 0;
        const size_t remaining = self->response.size() - (std::min)(self->offset, self->response.size());
        const size_t count = (std::min)(remaining, static_cast<size_t>(bytesToRead));
        if (!count) { *bytesRead = 0; return 0; }
        memcpy(output, self->response.data() + self->offset, count);
        self->offset += count;
        *bytesRead = static_cast<int>(count);
        return 1;
    }

    static void CEF_CALLBACK Cancel(cef_resource_handler_t* api) {
        auto* self = Self(api);
        self->canceled.store(true);
        std::lock_guard<std::mutex> lock(self->mutex);
        if (self->activeRequest) WinHttpCloseHandle(self->activeRequest);
        self->activeRequest = nullptr;
    }
};

struct ProxyResourceRequestHandler {
    cef_resource_request_handler_t api{};
    std::atomic<long> refs{1};
    ProxyRoute route = ProxyRoute::None;

    explicit ProxyResourceRequestHandler(ProxyRoute routeKind) : route(routeKind) {
        api.base.size = sizeof(api);
        api.base.add_ref = AddRef;
        api.base.release = Release;
        api.base.has_one_ref = HasOneRef;
        api.base.has_at_least_one_ref = HasAtLeastOneRef;
        api.get_resource_handler = GetResourceHandler;
    }
    static ProxyResourceRequestHandler* Self(cef_base_ref_counted_t* base) { return reinterpret_cast<ProxyResourceRequestHandler*>(base); }
    static ProxyResourceRequestHandler* Self(cef_resource_request_handler_t* api) { return reinterpret_cast<ProxyResourceRequestHandler*>(api); }
    static void CEF_CALLBACK AddRef(cef_base_ref_counted_t* base) { ++Self(base)->refs; }
    static int CEF_CALLBACK Release(cef_base_ref_counted_t* base) { auto* self = Self(base); if (--self->refs) return 0; delete self; return 1; }
    static int CEF_CALLBACK HasOneRef(cef_base_ref_counted_t* base) { return Self(base)->refs.load() == 1; }
    static int CEF_CALLBACK HasAtLeastOneRef(cef_base_ref_counted_t* base) { return Self(base)->refs.load() > 0; }
    static cef_resource_handler_t* CEF_CALLBACK GetResourceHandler(cef_resource_request_handler_t* api,
        cef_browser_t*, cef_frame_t*, cef_request_t*) {
        return &((new ProxyResourceHandler(Self(api)->route))->api);
    }
};

cef_resource_request_handler_t* CEF_CALLBACK HookGetResourceRequestHandler(
    cef_request_handler_t* self, cef_browser_t* browser, cef_frame_t* frame,
    cef_request_t* request, int isNavigation, int isDownload,
    const cef_string_t* requestInitiator, int* disableDefaultHandling) {
    const std::wstring url = request && request->get_url ? TakeUserfree(request->get_url(request)) : L"";
    const std::wstring method = request && request->get_method ? TakeUserfree(request->get_method(request)) : L"";
    const std::wstring initiator = requestInitiator && requestInitiator->str ?
        std::wstring(reinterpret_cast<const wchar_t*>(requestInitiator->str), requestInitiator->length) : L"";
    if (IsProxyRoute(url, initiator, method)) {
        if (disableDefaultHandling) *disableDefaultHandling = 1;
        return &((new ProxyResourceRequestHandler(RouteForPath(ParseUrl(url).path)))->api);
    }
    auto original = InstanceHooks<cef_request_handler_t>::original(self).get_resource_request_handler;
    return original ? original(self, browser, frame, request, isNavigation, isDownload,
        requestInitiator, disableDefaultHandling) : nullptr;
}

struct StandaloneRequestHandler {
    cef_request_handler_t api{};
    std::atomic<long> refs{1};
    StandaloneRequestHandler() {
        api.base.size = sizeof(api);
        api.base.add_ref = AddRef;
        api.base.release = Release;
        api.base.has_one_ref = HasOneRef;
        api.base.has_at_least_one_ref = HasAtLeastOneRef;
        api.get_resource_request_handler = HookGetResourceRequestHandler;
    }
    static StandaloneRequestHandler* Self(cef_base_ref_counted_t* base) { return reinterpret_cast<StandaloneRequestHandler*>(base); }
    static void CEF_CALLBACK AddRef(cef_base_ref_counted_t* base) { ++Self(base)->refs; }
    static int CEF_CALLBACK Release(cef_base_ref_counted_t* base) { auto* self = Self(base); if (--self->refs) return 0; delete self; return 1; }
    static int CEF_CALLBACK HasOneRef(cef_base_ref_counted_t* base) { return Self(base)->refs.load() == 1; }
    static int CEF_CALLBACK HasAtLeastOneRef(cef_base_ref_counted_t* base) { return Self(base)->refs.load() > 0; }
};

} // namespace

cef_request_handler_t* CreateNativeAiRequestHandler() {
    return &(new StandaloneRequestHandler())->api;
}

void InstallNativeAiRequestHandlerHooks(cef_request_handler_t* handler) {
    InstanceHooks<cef_request_handler_t>::install(handler, [](cef_request_handler_t* value) {
        value->get_resource_request_handler = HookGetResourceRequestHandler;
    });
}

bool IsAllowedAiProxyRouteForTest(const std::wstring& requestUrl,
                                  const std::wstring& initiator,
                                  const std::wstring& method) {
    return IsProxyRoute(requestUrl, initiator, method);
}

bool IsAllowedDeepSeekTargetForTest(const std::wstring& target) {
    return IsAllowedTarget(target);
}
