#include "pch.h"
#include "detours/detours.h"
#include "clipboard_repair.h"
#include "instance_hooks.h"
#include "cef_frame_scope.h"
#include <vector>
#include <algorithm>
#include "include/capi/cef_browser_capi.h"
#include "include/internal/cef_types_win.h"
#include "include/capi/cef_client_capi.h"
#include "include/internal/cef_win.h"

PVOID g_cef_browser_host_create_browser = nullptr;
// 诊断开关：解除切屏限制（Win+Tab/Alt+Tab）的 SetWindowsHookEx 挂钩。
// 置 0 可彻底关闭该功能，用于隔离排查启动崩溃是否由此引起。
#define ENABLE_UNBLOCK_SWITCH 1

// 诊断开关：往固定地址 0x00401000 写 NOP 的硬编码内存补丁。
// 该补丁是针对特定版本客户端的，版本不符会改坏代码导致启动崩溃。
// 置 0 可关闭，用于隔离排查。
#define ENABLE_MEMORY_PATCH 0

// 功能开关：从宿主 exe 同目录读取 gm_shim.js + dat.js 注入外部油猴脚本。
// 置 0 可关闭外部脚本注入。
#define ENABLE_USERSCRIPT 1

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
DWORD WINAPI UnhookKeyboardThread(LPVOID) {
    Sleep(8000);
    for (;;) {
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
        Sleep(2000);
    }
    return 0;
}

void SetAsPopup(cef_window_info_t* window_info) {
    window_info->style = WS_OVERLAPPEDWINDOW | WS_CLIPCHILDREN | WS_CLIPSIBLINGS | WS_VISIBLE;
    window_info->parent_window = NULL;
    window_info->x = CW_USEDEFAULT;
    window_info->y = CW_USEDEFAULT;
    window_info->width = CW_USEDEFAULT;
    window_info->height = CW_USEDEFAULT;
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
        h->on_key_event = hook_cef_on_key_event;
    });
    return keyboard_handler;
}

#if ENABLE_USERSCRIPT
// 获取宿主 exe 所在目录。
static std::wstring GetExeDir() {
    wchar_t path[MAX_PATH] = {};
    GetModuleFileNameW(NULL, path, MAX_PATH);
    PathRemoveFileSpecW(path);
    return std::wstring(path);
}

// 以 UTF-8 读取文件并转换为宽字符串（用于注入 JS）。
static bool ReadFileUtf8ToWString(const std::wstring& path, std::wstring& out) {
    HANDLE h = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, NULL,
        OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (h == INVALID_HANDLE_VALUE) {
        return false;
    }
    LARGE_INTEGER size{};
    if (!GetFileSizeEx(h, &size) || size.QuadPart <= 0 ||
        size.QuadPart >(LONGLONG)(64 * 1024 * 1024)) {
        CloseHandle(h);
        return false;
    }
    std::string buf;
    buf.resize((size_t)size.QuadPart);
    DWORD read = 0;
    BOOL ok = ReadFile(h, &buf[0], (DWORD)buf.size(), &read, NULL);
    CloseHandle(h);
    if (!ok) {
        return false;
    }
    buf.resize(read);
    // 去掉可能存在的 UTF-8 BOM
    if (buf.size() >= 3 && (unsigned char)buf[0] == 0xEF &&
        (unsigned char)buf[1] == 0xBB && (unsigned char)buf[2] == 0xBF) {
        buf.erase(0, 3);
    }
    if (buf.empty()) {
        return false;
    }
    int wlen = MultiByteToWideChar(CP_UTF8, 0, buf.data(), (int)buf.size(), NULL, 0);
    if (wlen <= 0) {
        return false;
    }
    out.resize(wlen);
    MultiByteToWideChar(CP_UTF8, 0, buf.data(), (int)buf.size(), &out[0], wlen);
    return true;
}

// 执行一段 JS（单次 execute_java_script），并释放临时 cef_string，避免内存泄漏。
static void ExecJs(struct _cef_frame_t* frame, const std::wstring& js) {
    if (!FrameCanExecute(frame) || !func_cef_string_from_ptr) return;
    cef_string_t code{};
    cef_string_t url{};
    if (func_cef_string_from_ptr(js.c_str(), js.length(), &code))
        frame->execute_java_script(frame, &code, &url, 0);
    if (code.dtor) {
        code.dtor(code.str);
    }
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

// 分片注入超长脚本：将脚本 base64 后逐片追加（每片单独 execute_java_script，
// 绕过单次注入的长度上限；base64 全是 ASCII，拼接不会被转义破坏），
// 最后在页面里 atob 解码并 eval 执行。
static void InjectScriptChunked(struct _cef_frame_t* frame,
                                const std::wstring& label,
                                const std::wstring& full) {
    std::wstring b64 = Base64EncodeUtf8(full);
    ExecJs(frame, L"window.__wnB='';");
    const size_t CHUNK = 8000; // 每片字符数，远低于单次注入上限
    for (size_t i = 0; i < b64.size(); i += CHUNK) {
        ExecJs(frame, L"window.__wnB+=\"" + b64.substr(i, CHUNK) + L"\";");
    }
    // 解码后单独 eval；失败时尽量定位语法错误所在位置（按行列裁出附近代码）。
    std::wstring js =
        L"try{"
        L"var __ws=decodeURIComponent(escape(atob(window.__wnB)));"
        L"console.log('[CefHook] [" + label + L"] chars=',__ws.length);"
        L"(0,eval)(__ws);"
        L"console.log('[CefHook] [" + label + L"] eval OK');"
        L"}catch(e){"
        L"console.error('[CefHook] [" + label + L"] eval FAIL:',e&&e.message);"
        L"try{"
        L"var m=String(e&&e.stack||'').match(/<anonymous>:(\\d+):(\\d+)/);"
        L"if(m){var ln=+m[1],col=+m[2];var lines=__ws.split('\\n');"
        L"console.error('[CefHook] [" + label + L"] at line',ln,'col',col,'=>',"
        L"(lines[ln-1]||'').slice(Math.max(0,col-40),col+40));}"
        L"else{console.error('[CefHook] [" + label + L"] head=',__ws.slice(0,200));}"
        L"}catch(_){}"
        L"}finally{window.__wnB='';}";
    ExecJs(frame, js);
}

// 读取并注入外部油猴脚本：gm_shim.js（运行时垫片）+ dat.js（主脚本）。
static void InjectUserScript(struct _cef_frame_t* frame) {
    if (!FrameCanExecute(frame)) return;
    // 探针：确认注入回调确实触发（极小，必定能执行）
    ExecJs(frame, L"window.__wnInject=(window.__wnInject||0)+1;"
        L"console.log('[CefHook] inject fired',window.__wnInject);");

    std::wstring dir = GetExeDir();
    std::wstring shim, mainScript;
    if (!ReadFileUtf8ToWString(dir + L"\\gm_shim.js", shim)) {
        OutputDebugString(L"[CefHook] gm_shim.js not found, skip userscript\n");
        ExecJs(frame, L"console.warn('[CefHook] gm_shim.js 未找到');");
        return;
    }
    if (!ReadFileUtf8ToWString(dir + L"\\dat.js", mainScript)) {
        OutputDebugString(L"[CefHook] dat.js not found, skip userscript\n");
        ExecJs(frame, L"console.warn('[CefHook] dat.js 未找到');");
        return;
    }

    // 先单独注入 gm_shim（定义 GM_* 与 __wnBootGM），再单独注入 dat.js，
    // 这样语法错误能明确归属到具体脚本。
    InjectScriptChunked(frame, L"shim", shim);
    ExecJs(frame, kUserScriptBootScript);

    std::wstring datWrapped;
    datWrapped.reserve(mainScript.size() + 512);
    // State is set to ready only after boot and entry execution succeed.
    // 在闭包里把 $/jQuery 绑定到我们隔离出来的 __wnJQ，避免使用（并覆盖）页面的 jQuery。
    datWrapped += L"window.__cefRunUserScript(function(){\nreturn (function($, jQuery){\n";
    datWrapped += mainScript;
    datWrapped += L"\n}).call(window, window.__wnJQ||window.$, window.__wnJQ||window.jQuery);\n";
    datWrapped += L"\n});\n";
    InjectScriptChunked(frame, L"dat", datWrapped);

    OutputDebugString(L"[CefHook] userscript injected (chunked)\n");
}
#endif

// One embedded event layer handles clipboard and text selection in every frame.
static void InjectCrackShim(struct _cef_frame_t* frame) {
    if (!FrameCanExecute(frame) || !func_cef_string_from_ptr) return;
    cef_string_t code{};
    cef_string_t url{};
    if (func_cef_string_from_ptr(kClipboardRepairScript,
        (sizeof(kClipboardRepairScript) / sizeof(wchar_t)) - 1, &code)) {
        frame->execute_java_script(frame, &code, &url, 0);
    }
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
        InjectUserScript(retained.get());
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
    });

    return reinterpret_cast<decltype(&hook_cef_browser_host_create_browser)>
        (g_cef_browser_host_create_browser)(
            windowInfo, client, url, settings, extra_info, request_context);
}

BOOL APIENTRY InstallHook() {
    if (DetourTransactionBegin() != NO_ERROR) return FALSE;
    if (DetourUpdateThread(GetCurrentThread()) != NO_ERROR) {
        DetourTransactionAbort(); return FALSE;
    }
    auto attach = [](PVOID* original, PVOID hook) {
        if (*original && DetourAttach(original, hook) == NO_ERROR) return true;
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
    if (!attach(&g_set_window_display_affinity, (PVOID)hook_set_window_display_affinity)) return FALSE;

#if ENABLE_UNBLOCK_SWITCH
    // Hook SetWindowsHookEx 以解除客户端对 Win+Tab / Alt+Tab 等切屏按键的封锁
    g_set_windows_hook_ex_w =
        DetourFindFunction("user32.dll", "SetWindowsHookExW");
    if (!attach(&g_set_windows_hook_ex_w, (PVOID)hook_set_windows_hook_ex_w)) return FALSE;

    g_set_windows_hook_ex_a =
        DetourFindFunction("user32.dll", "SetWindowsHookExA");
    if (!attach(&g_set_windows_hook_ex_a, (PVOID)hook_set_windows_hook_ex_a)) return FALSE;

    // Hook SetWindowPos 以阻止考试窗口强制置顶
    g_set_window_pos =
        DetourFindFunction("user32.dll", "SetWindowPos");
    if (!attach(&g_set_window_pos, (PVOID)hook_set_window_pos)) return FALSE;
#endif

#ifdef UNICODE
    func_cef_string_from_ptr = reinterpret_cast<cef_string_from_ptr_t>(DetourFindFunction("libcef.dll", "cef_string_wide_to_utf16"));
#else
    func_cef_string_from_ptr = reinterpret_cast<cef_string_from_ptr_t>(DetourFindFunction("libcef.dll", "cef_string_ascii_to_utf16"));
#endif

    if (!func_cef_string_from_ptr) { DetourTransactionAbort(); return FALSE; }
    if (!attach(&g_cef_browser_host_create_browser, (PVOID)hook_cef_browser_host_create_browser)) return FALSE;

    return DetourTransactionCommit() == NO_ERROR;
}

DWORD WINAPI ThreadProc(LPVOID lpThreadParameter)
{
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
        OutputDebugString(TEXT("[CefHook] Hook Failed"));
        return 1;
    }
    OutputDebugString(TEXT("[CefHook] Hook Success"));

#if ENABLE_UNBLOCK_SWITCH
    // 启动后台线程，延迟卸载客户端的全局键盘钩子以放行 Win+Tab / Alt+Tab
    HANDLE hUnhookThread = CreateThread(NULL, 0, UnhookKeyboardThread, NULL, 0, NULL);
    if (hUnhookThread) {
        CloseHandle(hUnhookThread);
    }
#endif

    return 0;
}
