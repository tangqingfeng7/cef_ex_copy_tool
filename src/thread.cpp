#include "pch.h"
#include "detours/detours.h"
#include "clipboard_repair.h"
#include "build_info.h"
#include "crash_dump.h"
#include "userscript_resources.h"
#include "instance_hooks.h"
#include "cef_frame_scope.h"
#include <vector>
#include <algorithm>
#include <climits>
#include "include/capi/cef_browser_capi.h"
#include "include/internal/cef_types_win.h"
#include "include/capi/cef_client_capi.h"
#include "include/internal/cef_win.h"
#include "embedded_script.h"
#include "frame_documents.h"
#include "ai_config.h"
#include "ai_native_proxy.h"

PVOID g_cef_browser_host_create_browser = nullptr;
// 诊断开关：解除切屏限制（Win+Tab/Alt+Tab）的 SetWindowsHookEx 挂钩。
// 置 0 可彻底关闭该功能，用于隔离排查启动崩溃是否由此引起。
#define ENABLE_UNBLOCK_SWITCH 1

// 诊断开关：往固定地址 0x00401000 写 NOP 的硬编码内存补丁。
// 该补丁是针对特定版本客户端的，版本不符会改坏代码导致启动崩溃。
// 置 0 可关闭，用于隔离排查。
#define ENABLE_MEMORY_PATCH 0

// 功能开关：从当前模块的 RCDATA 读取配套 gm_shim.js + dat.js。
// 置 0 可关闭内置用户脚本注入；不读取外置 JS。
#define ENABLE_USERSCRIPT 1

// The record is embedded in the DLL and read by the release verifier.
static const wchar_t kBuildRecord[] = CEF_CX_BUILD_RECORD;
static const size_t kBuildRecordPrefix = sizeof(L"CEF_CX_BUILD_INFO_V1:") / sizeof(wchar_t) - 1;

enum NativeLifecycleState { LifecycleIdle, LifecycleStarting, LifecycleRunning,
    LifecycleStopping, LifecycleStopped, LifecycleFailed };
enum NativeHookState { HookPending, HookInstalling, HookInstalled, HookFailed };
enum NativeHookPhase { HookPhaseNone, HookPhaseBegin, HookPhaseUpdateThread,
    HookPhaseDisplayAffinity, HookPhaseKeyboardW, HookPhaseKeyboardA,
    HookPhaseTopmost, HookPhaseCefString, HookPhaseCefBrowser, HookPhaseCommit };

static volatile LONG g_lifecycleState = LifecycleIdle;
static volatile LONG g_lifecycleError = 0;
static volatile LONG g_stopRequested = 0;
static volatile LONG g_hookState = HookPending;
static volatile LONG g_hookPhase = HookPhaseNone;
static volatile LONG g_hookError = 0;
static HANDLE g_stopEvent = nullptr;
static HANDLE g_workerThread = nullptr;

static const wchar_t* LifecycleStateName(LONG state) {
    switch (state) {
    case LifecycleStarting: return L"starting";
    case LifecycleRunning: return L"running";
    case LifecycleStopping: return L"stopping";
    case LifecycleStopped: return L"stopped";
    case LifecycleFailed: return L"failed";
    default: return L"idle";
    }
}

static const wchar_t* HookStateName(LONG state) {
    switch (state) {
    case HookInstalling: return L"installing";
    case HookInstalled: return L"installed";
    case HookFailed: return L"failed";
    default: return L"pending";
    }
}

static const wchar_t* HookPhaseName(LONG phase) {
    switch (phase) {
    case HookPhaseBegin: return L"begin";
    case HookPhaseUpdateThread: return L"update-thread";
    case HookPhaseDisplayAffinity: return L"display-affinity";
    case HookPhaseKeyboardW: return L"keyboard-w";
    case HookPhaseKeyboardA: return L"keyboard-a";
    case HookPhaseTopmost: return L"topmost";
    case HookPhaseCefString: return L"cef-string";
    case HookPhaseCefBrowser: return L"cef-browser";
    case HookPhaseCommit: return L"commit";
    default: return L"none";
    }
}

static std::wstring JsonEscape(const std::wstring& input) {
    std::wstring result;
    result.reserve(input.size() + 8);
    for (wchar_t ch : input) {
        if (ch == L'\\' || ch == L'"') result += L'\\';
        if (ch >= 0x20) result += ch;
    }
    return result;
}

static std::wstring HostProcessName() {
    wchar_t path[32768] = {};
    DWORD length = GetModuleFileNameW(nullptr, path, static_cast<DWORD>(_countof(path)));
    if (!length || length >= _countof(path)) return L"unknown";
    const wchar_t* name = wcsrchr(path, L'\\');
    return name ? name + 1 : path;
}

static std::wstring NativeDiagnosticsJson() {
    const LONG lifecycle = InterlockedCompareExchange(&g_lifecycleState, 0, 0);
    const LONG lifecycleError = InterlockedCompareExchange(&g_lifecycleError, 0, 0);
    const LONG hook = InterlockedCompareExchange(&g_hookState, 0, 0);
    const LONG phase = InterlockedCompareExchange(&g_hookPhase, 0, 0);
    const LONG hookError = InterlockedCompareExchange(&g_hookError, 0, 0);
    const bool stopRequested = InterlockedCompareExchange(&g_stopRequested, 0, 0) != 0;
    return L"{\"host\":{\"process\":\"" + JsonEscape(HostProcessName()) +
        L"\",\"pid\":" + std::to_wstring(GetCurrentProcessId()) +
        L",\"architecture\":\"x86\"},\"lifecycle\":{\"status\":\"" +
        LifecycleStateName(lifecycle) + L"\",\"stopRequested\":" +
        (stopRequested ? L"true" : L"false") + L",\"lastError\":" +
        std::to_wstring(lifecycleError) + L"},\"hooks\":{\"status\":\"" +
        HookStateName(hook) + L"\",\"phase\":\"" + HookPhaseName(phase) +
        L"\",\"lastError\":" + std::to_wstring(hookError) +
        L"},\"crashDump\":" + CrashDumpDiagnosticsJson() + L"}";
}

static std::wstring RuntimeVersionJson() {
    auto module = GetModuleHandleW(L"libcef.dll");
    using VersionInfo = int(__cdecl*)(int);
    auto version = module ? reinterpret_cast<VersionInfo>(GetProcAddress(module, "cef_version_info")) : nullptr;
    if (!version) return L"{\"cef\":\"unknown\",\"chromium\":\"unknown\"}";
    // Indices are defined in CEF's tools/make_version_header.py.
    auto parts = [version](int start, int count) {
        std::wstring result;
        for (int i = 0; i < count; ++i) {
            if (i) result += L'.';
            result += std::to_wstring(version(start + i));
        }
        return result;
    };
    return L"{\"cef\":\"" + parts(0, 3) + L"\",\"chromium\":\"" + parts(4, 4) + L"\"}";
}

PVOID g_set_window_display_affinity = nullptr;
PVOID g_set_windows_hook_ex_w = nullptr;
PVOID g_set_windows_hook_ex_a = nullptr;
PVOID g_set_window_pos = nullptr;

// 记录客户端安装的全局低级键盘钩子句柄，供后续主动卸载使用。
std::mutex g_keyboard_hooks_mutex;
std::vector<HHOOK> g_keyboard_hooks;

typedef int(CEF_EXPORT* cef_string_from_ptr_t)(const TCHAR*, size_t, cef_string_utf16_t*);
cef_string_from_ptr_t func_cef_string_from_ptr = nullptr;

// 新增的窗口显示属性Hook函数
BOOL WINAPI hook_set_window_display_affinity(HWND hWnd, DWORD dwAffinity) {
    OutputDebugString(L"[CefHook] hook_set_window_display_affinity\n");
    if (dwAffinity == WDA_NONE) {
        return TRUE;
    }
    return reinterpret_cast<decltype(&hook_set_window_display_affinity)>
        (g_set_window_display_affinity)(hWnd, WDA_NONE);
}

// 记录客户端安装的全局低级键盘钩子句柄。
// 采用“延迟卸载”策略：让钩子真正装上（启动期的完整性校验能通过，不会一进去就崩），
// 仅把 WH_KEYBOARD_LL 句柄记录下来，由后台线程在启动稳定后周期性卸载，
// 从而放行 Win+Tab / Alt+Tab 等被吞掉的切屏按键。
static void RememberKeyboardHook(int idHook, HHOOK hHook) {
    if (hHook && idHook == WH_KEYBOARD_LL) {
        std::lock_guard<std::mutex> lock(g_keyboard_hooks_mutex);
        if (std::find(g_keyboard_hooks.begin(), g_keyboard_hooks.end(), hHook) == g_keyboard_hooks.end())
            g_keyboard_hooks.push_back(hHook);
    }
}

HHOOK WINAPI hook_set_windows_hook_ex_w(int idHook, HOOKPROC lpfn, HINSTANCE hmod, DWORD dwThreadId) {
    HHOOK hHook = reinterpret_cast<decltype(&hook_set_windows_hook_ex_w)>
        (g_set_windows_hook_ex_w)(idHook, lpfn, hmod, dwThreadId);
    RememberKeyboardHook(idHook, hHook);
    return hHook;
}

HHOOK WINAPI hook_set_windows_hook_ex_a(int idHook, HOOKPROC lpfn, HINSTANCE hmod, DWORD dwThreadId) {
    HHOOK hHook = reinterpret_cast<decltype(&hook_set_windows_hook_ex_a)>
        (g_set_windows_hook_ex_a)(idHook, lpfn, hmod, dwThreadId);
    RememberKeyboardHook(idHook, hHook);
    return hHook;
}

// 拦截客户端的“置顶看门狗”：把 HWND_TOPMOST 的置顶请求改写为 HWND_NOTOPMOST，
// 使考试窗口无法再把自己强行顶到最上层，从而切屏后其他程序与任务栏可见。
BOOL WINAPI hook_set_window_pos(HWND hWnd, HWND hWndInsertAfter, int X, int Y, int cx, int cy, UINT uFlags) {
    if (hWndInsertAfter == HWND_TOPMOST) {
        hWndInsertAfter = HWND_NOTOPMOST;
    }
    return reinterpret_cast<decltype(&hook_set_window_pos)>
        (g_set_window_pos)(hWnd, hWndInsertAfter, X, Y, cx, cy, uFlags);
}

// 取消本进程所有顶层窗口的置顶属性。
BOOL CALLBACK DetopmostEnumProc(HWND hWnd, LPARAM /*lParam*/) {
    DWORD pid = 0;
    GetWindowThreadProcessId(hWnd, &pid);
    if (pid == GetCurrentProcessId()) {
        LONG_PTR exStyle = GetWindowLongPtr(hWnd, GWL_EXSTYLE);
        if (exStyle & WS_EX_TOPMOST) {
            SetWindowPos(hWnd, HWND_NOTOPMOST, 0, 0, 0, 0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
            OutputDebugString(L"[CefHook] removed WS_EX_TOPMOST from window\n");
        }
    }
    return TRUE;
}

// 恢复被客户端隐藏的任务栏（主任务栏 + 多显示器副任务栏）。
void RestoreTaskbar() {
    HWND hTray = FindWindow(TEXT("Shell_TrayWnd"), NULL);
    if (hTray && !IsWindowVisible(hTray)) {
        ShowWindow(hTray, SW_SHOW);
        OutputDebugString(L"[CefHook] restored Shell_TrayWnd\n");
    }

    HWND hSec = NULL;
    while ((hSec = FindWindowEx(NULL, hSec, TEXT("Shell_SecondaryTrayWnd"), NULL)) != NULL) {
        if (!IsWindowVisible(hSec)) {
            ShowWindow(hSec, SW_SHOW);
            OutputDebugString(L"[CefHook] restored Shell_SecondaryTrayWnd\n");
        }
    }
}

// 后台线程：先等待客户端启动稳定（完整性校验通过），再周期性卸载已记录的
// 全局低级键盘钩子，取消考试窗口的置顶属性，并恢复被隐藏的任务栏。
// 若客户端看门狗重新安装钩子/重新置顶/再次隐藏任务栏，会在下一轮被再次清除。
static void MaintainWindowState() {
    {
        std::lock_guard<std::mutex> lock(g_keyboard_hooks_mutex);
        for (auto it = g_keyboard_hooks.begin(); it != g_keyboard_hooks.end();) {
            if (UnhookWindowsHookEx(*it) || GetLastError() == ERROR_INVALID_HOOK_HANDLE)
                it = g_keyboard_hooks.erase(it);
            else ++it;
        }
    }
    EnumWindows(DetopmostEnumProc, 0);
    RestoreTaskbar();
}

void SetAsPopup(cef_window_info_t* window_info) {
    window_info->style = WS_OVERLAPPEDWINDOW | WS_CLIPCHILDREN | WS_CLIPSIBLINGS | WS_VISIBLE;
    window_info->parent_window = NULL;
    window_info->x = CW_USEDEFAULT;
    window_info->y = CW_USEDEFAULT;
    window_info->width = CW_USEDEFAULT;
    window_info->height = CW_USEDEFAULT;
}

static bool ToggleDeepSeekPanel(struct _cef_browser_t* browser);

// Intercept before renderer dispatch: works while a child editor iframe owns
// focus and prevents native + DOM handlers from toggling the panel twice.
int CEF_CALLBACK hook_cef_on_pre_key_event(
    struct _cef_keyboard_handler_t* self, struct _cef_browser_t* browser,
    const struct _cef_key_event_t* event, cef_event_handle_t os_event,
    int* is_keyboard_shortcut) {
    if (event && event->type == KEYEVENT_RAWKEYDOWN && event->windows_key_code == 'G'
        && (event->modifiers & EVENTFLAG_CONTROL_DOWN)
        && !(event->modifiers & (EVENTFLAG_ALT_DOWN | EVENTFLAG_SHIFT_DOWN | EVENTFLAG_COMMAND_DOWN))) {
        // Windows lParam bit 30 marks an auto-repeat, not another press.
        if ((static_cast<unsigned int>(event->native_key_code) & (1u << 30)) || ToggleDeepSeekPanel(browser)) {
            if (is_keyboard_shortcut) *is_keyboard_shortcut = 1;
            return 1;
        }
    }
    auto original = InstanceHooks<cef_keyboard_handler_t>::original(self).on_pre_key_event;
    return original ? original(self, browser, event, os_event, is_keyboard_shortcut) : 0;
}

int CEF_CALLBACK hook_cef_on_key_event(
    struct _cef_keyboard_handler_t* self,
    struct _cef_browser_t* browser,
    const struct _cef_key_event_t* event,
    cef_event_handle_t os_event) {

    if (event->type == KEYEVENT_RAWKEYDOWN
        && event->windows_key_code == 'P'
        && (event->modifiers & EVENTFLAG_CONTROL_DOWN)
        && (event->modifiers & EVENTFLAG_SHIFT_DOWN)) {
        auto cef_browser_host = browser->get_host(browser);
        if (!cef_browser_host) return 0;
        cef_window_info_t windowInfo{};
        cef_browser_settings_t settings{};
        settings.size = sizeof(settings);
        cef_point_t point{};
        SetAsPopup(&windowInfo);
        cef_browser_host->show_dev_tools(cef_browser_host, &windowInfo, 0, &settings, &point);
        cef_browser_host->base.release(&cef_browser_host->base);
    }

    auto original = InstanceHooks<cef_keyboard_handler_t>::original(self).on_key_event;
    return original ? original(self, browser, event, os_event) : 0;
}

struct _cef_keyboard_handler_t* CEF_CALLBACK hook_cef_get_keyboard_handler(
    struct _cef_client_t* self) {
    auto original = InstanceHooks<cef_client_t>::original(self).get_keyboard_handler;
    auto keyboard_handler = original ? original(self) : nullptr;
    InstanceHooks<cef_keyboard_handler_t>::install(keyboard_handler, [](cef_keyboard_handler_t* h) {
        h->on_pre_key_event = hook_cef_on_pre_key_event;
        h->on_key_event = hook_cef_on_key_event;
    });
    return keyboard_handler;
}

struct _cef_request_handler_t* CEF_CALLBACK hook_cef_get_request_handler(
    struct _cef_client_t* self) {
    auto original = InstanceHooks<cef_client_t>::original(self).get_request_handler;
    auto request_handler = original ? original(self) : nullptr;
    if (request_handler) InstallNativeAiRequestHandlerHooks(request_handler);
    else request_handler = CreateNativeAiRequestHandler();
    return request_handler;
}

#if ENABLE_USERSCRIPT
static FrameDocuments g_frameDocuments;
// Resolve the actual containing module, not a possibly ambiguous winmm.dll name.
// Load resources in memory; no extraction and no dependency on the EXE directory.
static std::wstring LoadEmbeddedUserScript(WORD id) {
    HMODULE module = nullptr;
    if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
        GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
        reinterpret_cast<LPCWSTR>(&LoadEmbeddedUserScript), &module)) return {};
    HRSRC resource = FindResourceW(module, MAKEINTRESOURCEW(id), RT_RCDATA);
    if (!resource) return {};
    DWORD size = SizeofResource(module, resource);
    HGLOBAL loaded = LoadResource(module, resource);
    const char* bytes = loaded ? static_cast<const char*>(LockResource(loaded)) : nullptr;
    if (!bytes || !size || size > INT_MAX) return {};
    std::string decoded;
    if (!DecodeScriptPacket(reinterpret_cast<const unsigned char*>(bytes), size, decoded)) return {};
    std::wstring source;
    if (!ScriptUtf8ToWide(decoded, source)) return {};
    return source;
}

// 执行一段 JS（单次 execute_java_script），并释放临时 cef_string，避免内存泄漏。
static void ExecJs(struct _cef_frame_t* frame, const std::wstring& js,
                   const std::wstring& sourceName = L"cef-cx/bootstrap.js") {
    if (!FrameCanExecute(frame) || !func_cef_string_from_ptr) return;
    cef_string_t code{};
    cef_string_t url{};
    if (func_cef_string_from_ptr(js.c_str(), js.length(), &code) &&
        func_cef_string_from_ptr(sourceName.c_str(), sourceName.length(), &url))
        frame->execute_java_script(frame, &code, &url, 0);
    if (url.dtor) url.dtor(url.str);
    if (code.dtor) {
        code.dtor(code.str);
    }
}

static bool ToggleDeepSeekPanel(struct _cef_browser_t* browser) {
    if (!browser || !browser->get_main_frame || !func_cef_string_from_ptr) return false;
    auto* frame = browser->get_main_frame(browser); // Returned with one reference.
    if (!frame) return false;
    const bool ready = FrameCanExecute(frame);
    if (ready) ExecJs(frame, L"if(window.__cefDeepSeek&&window.__cefDeepSeek.toggleSettings)window.__cefDeepSeek.toggleSettings();", L"cef-cx/ai-hotkey.js");
    if (frame->base.release) frame->base.release(&frame->base);
    return ready;
}

// 将宽字符串先转 UTF-8，再做 base64 编码（输出仅含 ASCII，拼接时无需转义）。
static std::wstring Base64EncodeUtf8(const std::wstring& wide) {
    std::string utf8;
    int n = WideCharToMultiByte(CP_UTF8, 0, wide.c_str(), (int)wide.size(), NULL, 0, NULL, NULL);
    if (n > 0) {
        utf8.resize(n);
        WideCharToMultiByte(CP_UTF8, 0, wide.c_str(), (int)wide.size(), &utf8[0], n, NULL, NULL);
    }
    static const char* T =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::wstring out;
    out.reserve(((utf8.size() + 2) / 3) * 4);
    size_t i = 0;
    for (; i + 3 <= utf8.size(); i += 3) {
        unsigned v = ((unsigned char)utf8[i] << 16) |
            ((unsigned char)utf8[i + 1] << 8) | (unsigned char)utf8[i + 2];
        out += (wchar_t)T[(v >> 18) & 63];
        out += (wchar_t)T[(v >> 12) & 63];
        out += (wchar_t)T[(v >> 6) & 63];
        out += (wchar_t)T[v & 63];
    }
    size_t rem = utf8.size() - i;
    if (rem == 1) {
        unsigned v = ((unsigned char)utf8[i] << 16);
        out += (wchar_t)T[(v >> 18) & 63];
        out += (wchar_t)T[(v >> 12) & 63];
        out += L'=';
        out += L'=';
    } else if (rem == 2) {
        unsigned v = ((unsigned char)utf8[i] << 16) | ((unsigned char)utf8[i + 1] << 8);
        out += (wchar_t)T[(v >> 18) & 63];
        out += (wchar_t)T[(v >> 12) & 63];
        out += (wchar_t)T[(v >> 6) & 63];
        out += L'=';
    }
    return out;
}

// Preserve the existing entry wrapper and private jQuery binding.
static std::wstring WrapUserScript(const std::wstring& mainScript) {
    return L"window.__cefRunUserScript(function(){\nreturn (function($, jQuery){\n" + mainScript +
        L"\n}).call(window, window.__wnJQ||window.$, window.__wnJQ||window.jQuery);\n});\n";
}

static void InjectScriptChunked(struct _cef_frame_t* frame,
                                const std::wstring& file,
                                const std::wstring& encoded) {
    ExecJs(frame, L"window.__wnB='';");
    const size_t CHUNK = 8000;
    for (size_t i = 0; i < encoded.size(); i += CHUNK)
        ExecJs(frame, L"if(window.__cefInjectionAllowed)window.__wnB+=\"" + encoded.substr(i, CHUNK) + L"\";", L"cef-cx/transport/" + file);
    ExecJs(frame, L"try{if(window.__cefInjectionAllowed){"
        L"window.__cefEvaluateScript('" + file + L"',decodeURIComponent(escape(atob(window.__wnB))));"
        L"}}catch(e){window.__cefReportUserScriptFailure('" + file + L"','decode','decode-error');}"
        L"finally{window.__wnB='';}");
}

static void InjectUserScript(struct _cef_frame_t* frame, unsigned long long generation = 0) {
    if (!FrameCanExecute(frame)) return;
    const ULONGLONG begin = GetTickCount64();
    ExecJs(frame, kUserScriptBootScript);
    ExecJs(frame, L"window.__cefInjectionAllowed=window.__cefBeginUserScriptInjection();");
    static const std::wstring shim = Base64EncodeUtf8(LoadEmbeddedUserScript(IDR_GM_SHIM_SCRIPT));
    static const std::wstring dat = [] {
        const auto source = LoadEmbeddedUserScript(IDR_DAT_SCRIPT);
        return source.empty() ? std::wstring() : Base64EncodeUtf8(WrapUserScript(source));
    }();
    if (shim.empty()) {
        ExecJs(frame, L"if(window.__cefInjectionAllowed)window.__cefReportUserScriptFailure("
            L"'gm_shim.js','read','embedded-resource-missing-or-invalid');");
        return;
    }
    if (dat.empty()) {
        ExecJs(frame, L"if(window.__cefInjectionAllowed)window.__cefReportUserScriptFailure("
            L"'dat.js','read','embedded-resource-missing-or-invalid');");
        return;
    }
    const ULONGLONG prepared = GetTickCount64();
    const size_t chunks = (shim.size() + 7999) / 8000 + (dat.size() + 7999) / 8000;
    ExecJs(frame, L"window.__cefInjectionMetrics={storage:'CXZ1/LZMS',generation:" +
        std::to_wstring(generation) + L",chunks:" + std::to_wstring(chunks) +
        L",encodedCharacters:" + std::to_wstring(shim.size() + dat.size()) +
        L",prepareMs:" + std::to_wstring(prepared - begin) + L"};");
    ExecJs(frame, LoadAiConfigPrelude(), L"cef-cx/ai-config.js");
    InjectScriptChunked(frame, L"gm_shim.js", shim);
    InjectScriptChunked(frame, L"dat.js", dat);
    ExecJs(frame, L"if(window.__cefInjectionMetrics)window.__cefInjectionMetrics.dispatchMs=" +
        std::to_wstring(GetTickCount64() - prepared) + L";");
}

#endif

// One embedded event layer handles clipboard and text selection in every frame.
static void InjectCrackShim(struct _cef_frame_t* frame) {
    if (!FrameCanExecute(frame) || !func_cef_string_from_ptr) return;
    cef_string_t code{};
    cef_string_t url{};
    std::wstring script = L"window.__cefBuildInfo=" + std::wstring(kBuildRecord + kBuildRecordPrefix) +
        L";window.__cefRuntimeInfo=" + RuntimeVersionJson() +
        L";window.__cefNativeInfo=" + NativeDiagnosticsJson() +
        L";window.__cefNativeAiProxy=Object.freeze({version:1,deepseekOnly:true,configWrite:true});\n";
#if !ENABLE_USERSCRIPT
    script += L"window.__cefUserScriptState={status:'disabled',reason:'build-option'};\n";
#else
    if (frame->is_main && !frame->is_main(frame))
        script += L"window.__cefUserScriptState={status:'skipped',reason:'subframe'};\n";
#endif
    script += kClipboardRepairScript;
    script += kDiagnosticsScript;
    const std::wstring sourceName = L"cef-cx/repair.js";
    if (func_cef_string_from_ptr(script.c_str(), script.size(), &code) &&
        func_cef_string_from_ptr(sourceName.c_str(), sourceName.size(), &url)) {
        frame->execute_java_script(frame, &code, &url, 0);
    }
    if (url.dtor) url.dtor(url.str);
    if (code.dtor) code.dtor(code.str);
}

// 页面开始加载即注入破解 shim，尽量抢在页面脚本注册复制/粘贴拦截器之前生效。
void CEF_CALLBACK hook_cef_on_load_start(
    struct _cef_load_handler_t* self,
    struct _cef_browser_t* browser,
    struct _cef_frame_t* frame,
    cef_transition_type_t transition_type)
{
    ScopedCefFrame retained(frame);
#if ENABLE_USERSCRIPT
    if (FrameCanExecute(retained.get()) && frame->is_main && frame->is_main(frame))
        g_frameDocuments.start(frame, browser);
#endif
    InjectCrackShim(retained.get());

    auto original = InstanceHooks<cef_load_handler_t>::original(self).on_load_start;
    if (original) original(self, browser, frame, transition_type);
}

void CEF_CALLBACK hook_cef_on_load_end(
    struct _cef_load_handler_t* self,
    struct _cef_browser_t* browser,
    struct _cef_frame_t* frame,
    int httpStatusCode)
{
    ScopedCefFrame retained(frame);
    auto original = InstanceHooks<cef_load_handler_t>::original(self).on_load_end;
    if (original) original(self, browser, frame, httpStatusCode);
    // 幂等：on_load_start 已注入则此处仅补一次（确保样式在 DOM 就绪后已应用）。
    if (!FrameCanExecute(retained.get())) return;
    InjectCrackShim(retained.get());

#if ENABLE_USERSCRIPT
    // 仅在主框架注入，避免子框架/多次加载重复注入大脚本
    if (frame->is_main && frame->is_main(frame)) {
        unsigned long long generation = 0;
        if (g_frameDocuments.begin(retained.get(), browser, generation))
            InjectUserScript(retained.get(), generation);
        else ExecJs(retained.get(), L"if(window.__cefInjectionMetrics)window.__cefInjectionMetrics.duplicateSkips=" +
            std::to_wstring(g_frameDocuments.skipped()) + L";");
    }
#endif
}


struct _cef_load_handler_t* CEF_CALLBACK hook_cef_get_load_handler(
    struct _cef_client_t* self) {
    auto original = InstanceHooks<cef_client_t>::original(self).get_load_handler;
    auto load_handler = original ? original(self) : nullptr;
    InstanceHooks<cef_load_handler_t>::install(load_handler, [](cef_load_handler_t* h) {
        h->on_load_start = hook_cef_on_load_start;
        h->on_load_end = hook_cef_on_load_end;
    });
    return load_handler;
}

int hook_cef_browser_host_create_browser(
    const cef_window_info_t* windowInfo,
    struct _cef_client_t* client,
    const cef_string_t* url,
    const struct _cef_browser_settings_t* settings,
    struct _cef_dictionary_value_t* extra_info,
    struct _cef_request_context_t* request_context) {

    InstanceHooks<cef_client_t>::install(client, [](cef_client_t* c) {
        if (c->get_keyboard_handler) c->get_keyboard_handler = hook_cef_get_keyboard_handler;
        if (c->get_load_handler) c->get_load_handler = hook_cef_get_load_handler;
        if (CEF_MEMBER_EXISTS(c, get_request_handler)) c->get_request_handler = hook_cef_get_request_handler;
    });

    return reinterpret_cast<decltype(&hook_cef_browser_host_create_browser)>
        (g_cef_browser_host_create_browser)(
            windowInfo, client, url, settings, extra_info, request_context);
}

BOOL APIENTRY InstallHook() {
    InterlockedExchange(&g_hookState, HookInstalling);
    InterlockedExchange(&g_hookPhase, HookPhaseBegin);
    LONG result = DetourTransactionBegin();
    if (result != NO_ERROR) {
        InterlockedExchange(&g_hookError, result);
        InterlockedExchange(&g_hookState, HookFailed);
        return FALSE;
    }
    InterlockedExchange(&g_hookPhase, HookPhaseUpdateThread);
    result = DetourUpdateThread(GetCurrentThread());
    if (result != NO_ERROR) {
        InterlockedExchange(&g_hookError, result);
        InterlockedExchange(&g_hookState, HookFailed);
        DetourTransactionAbort(); return FALSE;
    }
    auto attach = [](PVOID* original, PVOID hook, NativeHookPhase phase) {
        InterlockedExchange(&g_hookPhase, phase);
        if (!*original) {
            InterlockedExchange(&g_hookError, ERROR_PROC_NOT_FOUND);
            InterlockedExchange(&g_hookState, HookFailed);
            DetourTransactionAbort();
            return false;
        }
        LONG error = DetourAttach(original, hook);
        if (error == NO_ERROR) return true;
        InterlockedExchange(&g_hookError, error);
        InterlockedExchange(&g_hookState, HookFailed);
        OutputDebugString(L"[CefHook] hook target missing or attach failed; aborting transaction\n");
        DetourTransactionAbort();
        return false;
    };

    // Hook CEF相关函数
    g_cef_browser_host_create_browser =
        DetourFindFunction("libcef.dll", "cef_browser_host_create_browser");

    // Hook SetWindowDisplayAffinity
    g_set_window_display_affinity =
        DetourFindFunction("user32.dll", "SetWindowDisplayAffinity");
    if (!attach(&g_set_window_display_affinity, (PVOID)hook_set_window_display_affinity,
            HookPhaseDisplayAffinity)) return FALSE;

#if ENABLE_UNBLOCK_SWITCH
    // Hook SetWindowsHookEx 以解除客户端对 Win+Tab / Alt+Tab 等切屏按键的封锁
    g_set_windows_hook_ex_w =
        DetourFindFunction("user32.dll", "SetWindowsHookExW");
    if (!attach(&g_set_windows_hook_ex_w, (PVOID)hook_set_windows_hook_ex_w,
            HookPhaseKeyboardW)) return FALSE;

    g_set_windows_hook_ex_a =
        DetourFindFunction("user32.dll", "SetWindowsHookExA");
    if (!attach(&g_set_windows_hook_ex_a, (PVOID)hook_set_windows_hook_ex_a,
            HookPhaseKeyboardA)) return FALSE;

    // Hook SetWindowPos 以阻止考试窗口强制置顶
    g_set_window_pos =
        DetourFindFunction("user32.dll", "SetWindowPos");
    if (!attach(&g_set_window_pos, (PVOID)hook_set_window_pos,
            HookPhaseTopmost)) return FALSE;
#endif

    InterlockedExchange(&g_hookPhase, HookPhaseCefString);
#ifdef UNICODE
    func_cef_string_from_ptr = reinterpret_cast<cef_string_from_ptr_t>(DetourFindFunction("libcef.dll", "cef_string_wide_to_utf16"));
#else
    func_cef_string_from_ptr = reinterpret_cast<cef_string_from_ptr_t>(DetourFindFunction("libcef.dll", "cef_string_ascii_to_utf16"));
#endif

    if (!func_cef_string_from_ptr) {
        InterlockedExchange(&g_hookError, ERROR_PROC_NOT_FOUND);
        InterlockedExchange(&g_hookState, HookFailed);
        DetourTransactionAbort(); return FALSE;
    }
    if (!attach(&g_cef_browser_host_create_browser, (PVOID)hook_cef_browser_host_create_browser,
            HookPhaseCefBrowser)) return FALSE;

    InterlockedExchange(&g_hookPhase, HookPhaseCommit);
    result = DetourTransactionCommit();
    if (result != NO_ERROR) {
        InterlockedExchange(&g_hookError, result);
        InterlockedExchange(&g_hookState, HookFailed);
        return FALSE;
    }
    InterlockedExchange(&g_hookError, 0);
    InterlockedExchange(&g_hookState, HookInstalled);
    return TRUE;
}

DWORD WINAPI ThreadProc(LPVOID lpThreadParameter)
{
    (void)lpThreadParameter;
    HMODULE pinnedModule = nullptr;
    LPCWSTR moduleAddress = reinterpret_cast<LPCWSTR>(const_cast<LONG*>(&g_lifecycleState));
    if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_PIN,
            moduleAddress, &pinnedModule)) {
        InterlockedExchange(&g_lifecycleError, static_cast<LONG>(GetLastError()));
    }
    InstallCrashDumpHandler();
    OutputDebugStringW(L"[CefHook] " CEF_CX_BUILD_RECORD L"\n");
    OutputDebugStringW((L"[CefHook] runtime " + RuntimeVersionJson() + L"\n").c_str());
#if ENABLE_MEMORY_PATCH
    HANDLE hProcess = OpenProcess(
        PROCESS_VM_OPERATION | PROCESS_VM_READ | PROCESS_VM_WRITE,
        FALSE,
        GetCurrentProcessId()
    );

    if (hProcess) {
        BYTE nopPatch[] = { 0x90, 0x90, 0x90, 0x90 };
        WriteProcessMemory(hProcess, (LPVOID)0x00401000, nopPatch, sizeof(nopPatch), NULL);
        CloseHandle(hProcess);
    }
#endif

    if (!InstallHook()) {
        const LONG phase = InterlockedCompareExchange(&g_hookPhase, 0, 0);
        const LONG error = InterlockedCompareExchange(&g_hookError, 0, 0);
        OutputDebugStringW((L"[CefHook] hook failed phase=" + std::wstring(HookPhaseName(phase)) +
            L" error=" + std::to_wstring(error) + L"\n").c_str());
        InterlockedExchange(&g_lifecycleState, LifecycleFailed);
        return 1;
    }
    OutputDebugString(TEXT("[CefHook] Hook Success"));
    InterlockedExchange(&g_lifecycleState, LifecycleRunning);

#if ENABLE_UNBLOCK_SWITCH
    DWORD wait = WaitForSingleObject(g_stopEvent, 8000);
    while (wait == WAIT_TIMEOUT) {
        MaintainWindowState();
        wait = WaitForSingleObject(g_stopEvent, 2000);
    }
#else
    WaitForSingleObject(g_stopEvent, INFINITE);
#endif
    InterlockedExchange(&g_lifecycleState, LifecycleStopping);
    InterlockedExchange(&g_lifecycleState, LifecycleStopped);
    return 0;
}

BOOL StartCefHookWorker() {
    if (InterlockedCompareExchange(&g_lifecycleState, LifecycleStarting, LifecycleIdle) != LifecycleIdle)
        return g_workerThread != nullptr;
    g_stopEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    if (!g_stopEvent) {
        InterlockedExchange(&g_lifecycleError, static_cast<LONG>(GetLastError()));
        InterlockedExchange(&g_lifecycleState, LifecycleFailed);
        return FALSE;
    }
    g_workerThread = CreateThread(nullptr, 0, ThreadProc, nullptr, 0, nullptr);
    if (!g_workerThread) {
        InterlockedExchange(&g_lifecycleError, static_cast<LONG>(GetLastError()));
        CloseHandle(g_stopEvent);
        g_stopEvent = nullptr;
        InterlockedExchange(&g_lifecycleState, LifecycleFailed);
        return FALSE;
    }
    return TRUE;
}

void SignalCefHookShutdown() {
    InterlockedExchange(&g_stopRequested, 1);
    if (g_stopEvent) SetEvent(g_stopEvent);
}
