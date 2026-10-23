// Exercise the production proxy/CEF callbacks using a deterministic WinHTTP
// transport. No URL allowlist relaxation and no real API/key/network involved.
#include <windows.h>
#include <winhttp.h>
#include <string>
#include <vector>
#include <stdexcept>
#include <iostream>
#include <cstring>
#define CHECK(x) do { if (!(x)) throw std::runtime_error(#x); } while (0)
namespace wire {
std::vector<std::string> chunks;
size_t index = 0;
bool failAfterFirst = false, cancelAfterFirst = false;
int headers = 0, reads = 0, requestCloses = 0;
void (*betweenChunks)() = nullptr;
HINTERNET WINAPI open(LPCWSTR, DWORD, LPCWSTR, LPCWSTR, DWORD) { return reinterpret_cast<HINTERNET>(1); }
BOOL WINAPI timeouts(HINTERNET, int, int, int, int) { return TRUE; }
HINTERNET WINAPI connect(HINTERNET, LPCWSTR, INTERNET_PORT, DWORD) { return reinterpret_cast<HINTERNET>(2); }
HINTERNET WINAPI request(HINTERNET, LPCWSTR, LPCWSTR, LPCWSTR, LPCWSTR, LPCWSTR*, DWORD) { return reinterpret_cast<HINTERNET>(3); }
BOOL WINAPI close(HINTERNET h) { if (h == reinterpret_cast<HINTERNET>(3)) ++requestCloses; return TRUE; }
BOOL WINAPI option(HINTERNET, DWORD, LPVOID, DWORD) { return TRUE; }
BOOL WINAPI send(HINTERNET, LPCWSTR, DWORD, LPVOID, DWORD, DWORD, DWORD_PTR) { return TRUE; }
BOOL WINAPI receive(HINTERNET, LPVOID) { return TRUE; }
BOOL WINAPI header(HINTERNET, DWORD info, LPCWSTR, LPVOID output, LPDWORD size, LPDWORD) {
    if (info & WINHTTP_QUERY_FLAG_NUMBER) { *reinterpret_cast<DWORD*>(output) = 200; return TRUE; }
    const wchar_t mime[] = L"text/event-stream";
    if (*size < sizeof(mime)) return FALSE;
    memcpy(output, mime, sizeof(mime)); *size = sizeof(mime); return TRUE;
}
BOOL WINAPI available(HINTERNET, LPDWORD count) {
    CHECK(headers == 1); // Open must continue before waiting for the whole body.
    if (index == 1 && betweenChunks) betweenChunks();
    if (index == 1 && failAfterFirst) { SetLastError(ERROR_CONNECTION_ABORTED); return FALSE; }
    *count = index < chunks.size() ? static_cast<DWORD>(chunks[index].size()) : 0;
    return TRUE;
}
BOOL WINAPI read(HINTERNET, LPVOID out, DWORD capacity, LPDWORD count) {
    CHECK(index < chunks.size() && capacity >= chunks[index].size());
    *count = static_cast<DWORD>(chunks[index].size()); memcpy(out, chunks[index].data(), *count); ++index; return TRUE;
}
}
#define WinHttpOpen wire::open
#define WinHttpSetTimeouts wire::timeouts
#define WinHttpConnect wire::connect
#define WinHttpOpenRequest wire::request
#define WinHttpCloseHandle wire::close
#define WinHttpSetOption wire::option
#define WinHttpSendRequest wire::send
#define WinHttpReceiveResponse wire::receive
#define WinHttpQueryHeaders wire::header
#define WinHttpQueryDataAvailable wire::available
#define WinHttpReadData wire::read
#include "../src/ai_native_proxy.cpp"

ProxyResourceHandler* current = nullptr;
char buffer[4096]{};
std::string received;
int lastCount = -999, callbackRefs = 1;
cef_resource_read_callback_t readCallback{};
void CEF_CALLBACK add(cef_base_ref_counted_t*) { ++callbackRefs; }
int CEF_CALLBACK release(cef_base_ref_counted_t*) { return --callbackRefs == 0; }
void queueRead() {
    int n = -999;
    const int ok = current->api.read(&current->api, buffer, sizeof(buffer), &n, &readCallback);
    if (n > 0) received.append(buffer, n);
    if (!ok) lastCount = n;
}
void CEF_CALLBACK gotRead(cef_resource_read_callback_t*, int n) {
    ++wire::reads; lastCount = n;
    if (n > 0) { received.append(buffer, n); queueRead(); }
}
void CEF_CALLBACK gotHeaders(cef_callback_t*) {
    ++wire::headers;
    CHECK(current->streamOpened.load() && current->mime == L"text/event-stream");
    int64 length = 0; cef_response_t response{};
    current->api.get_response_headers(&current->api, &response, &length, nullptr);
    CHECK(length == -1); queueRead();
}
void between() {
    CHECK(received == "data: first\n\n" && wire::reads == 1); // Observable before EOF.
    if (wire::cancelAfterFirst) current->api.cancel(&current->api);
}
void run(bool error, bool cancel) {
    ProxyResourceHandler handler(ProxyRoute::Chat); current = &handler; handler.streamWanted = true;
    wire::chunks = { "data: first\n\n", "data: second\n\n", "data: [DONE]\n\n" };
    wire::index = 0; wire::headers = 0; wire::reads = 0; wire::requestCloses = 0;
    wire::failAfterFirst = error; wire::cancelAfterFirst = cancel; wire::betweenChunks = between;
    received.clear(); callbackRefs = 1; lastCount = -999;
    readCallback = {}; readCallback.base.size = sizeof(readCallback); readCallback.base.add_ref = add; readCallback.base.release = release; readCallback.cont = gotRead;
    cef_callback_t headers{}; headers.cont = gotHeaders;
    handler.Perform(L"https://api.deepseek.com/chat/completions", L"fixture-only", {}, 5000, &headers);
    CHECK(wire::headers == 1 && callbackRefs == 1 && wire::requestCloses == 1);
    if (cancel) CHECK(handler.canceled.load() && received == "data: first\n\n");
    else if (error) CHECK(lastCount == -2 && received == "data: first\n\n");
    else CHECK(lastCount == 0 && received == "data: first\n\ndata: second\n\ndata: [DONE]\n\n");
}
int main() {
    try { run(false, false); run(true, false); run(false, true);
        std::cout << "PASS: production WinHTTP proxy streams headers/first bytes before EOF; CEF pending reads, midstream errors and cancellation close/release exactly once\n";
        return 0;
    } catch (const std::exception& e) { std::cerr << e.what() << '\n'; return 1; }
}
