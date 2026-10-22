#include <stdexcept>
#include <iostream>
#include "../src/thread.cpp"

#define CHECK(x) do { if (!(x)) throw std::runtime_error(#x); } while (0)
static int callsA = 0, callsB = 0, scripts = 0;
static int frameRefs = 1;
static bool detached = false;
static bool captureScripts = false;
static std::vector<std::wstring> injected;
static void CEF_CALLBACK frameAddRef(cef_base_ref_counted_t*) { ++frameRefs; }
static int CEF_CALLBACK frameRelease(cef_base_ref_counted_t*) { CHECK(frameRefs > 0); return --frameRefs == 0; }
static int CEF_CALLBACK frameValid(cef_frame_t*) { return frameRefs > 0 && !detached; }
static cef_client_t clientA{}, clientB{};
static cef_load_handler_t loadA{}, loadB{};
static int CEF_CALLBACK releaseFake(cef_base_ref_counted_t*) { return 1; }
static void CEF_CALLBACK endA(cef_load_handler_t*, cef_browser_t*, cef_frame_t*, int) { ++callsA; }
static void CEF_CALLBACK endB(cef_load_handler_t*, cef_browser_t*, cef_frame_t*, int) { ++callsB; }
static cef_load_handler_t* CEF_CALLBACK getA(cef_client_t*) { return &loadA; }
static cef_load_handler_t* CEF_CALLBACK getB(cef_client_t*) { return &loadB; }
static cef_frame_t* shortcutFrame = nullptr;
static cef_frame_t* CEF_CALLBACK shortcutMain(cef_browser_t*) {
    if (shortcutFrame) shortcutFrame->base.add_ref(&shortcutFrame->base);
    return shortcutFrame;
}
static int preKeyCalls = 0;
static int CEF_CALLBACK originalPreKey(cef_keyboard_handler_t*, cef_browser_t*, const cef_key_event_t*, cef_event_handle_t, int*) { ++preKeyCalls; return 7; }
static int createFake(const cef_window_info_t*, cef_client_t*, const cef_string_t*,
    const cef_browser_settings_t*, cef_dictionary_value_t*, cef_request_context_t*) { return 42; }
static void CEF_CALLBACK execFake(cef_frame_t*, const cef_string_t* code, const cef_string_t*, int) {
    CHECK(frameRefs > 0 && !detached); ++scripts;
    if (captureScripts) injected.emplace_back(reinterpret_cast<const wchar_t*>(code->str), code->length);
}
static void CEF_CALLBACK endConsumesFrame(cef_load_handler_t*, cef_browser_t*, cef_frame_t* frame, int) {
    frame->base.release(&frame->base);
}
static void CEF_CALLBACK endClosesFrame(cef_load_handler_t*, cef_browser_t*, cef_frame_t*, int) { detached = true; }
static int CEF_CALLBACK notMain(cef_frame_t*) { return 0; }
static int CEF_CALLBACK isMain(cef_frame_t*) { return 1; }
static int CEF_EXPORT stringFake(const TCHAR* text, size_t len, cef_string_utf16_t* out) {
    out->str = reinterpret_cast<char16*>(const_cast<TCHAR*>(text));
    out->length = len;
    return 1;
}
template<class T> void init(T& value) {
    value = T{}; value.base.size = sizeof(T); value.base.release = releaseFake;
}
int main() {
    try {
        init(clientA); init(clientB); init(loadA); init(loadB);
        clientA.get_load_handler = getA; clientB.get_load_handler = getB;
        loadA.on_load_end = endA; loadB.on_load_end = endB;
        g_cef_browser_host_create_browser = reinterpret_cast<PVOID>(createFake);
        func_cef_string_from_ptr = stringFake;
        cef_frame_t frame{}; frame.execute_java_script = execFake; frame.is_main = notMain;
        frame.base.add_ref = frameAddRef; frame.base.release = frameRelease; frame.is_valid = frameValid;
        for (int i = 0; i < 5; ++i) {
            CHECK(hook_cef_browser_host_create_browser(nullptr, &clientA, nullptr, nullptr, nullptr, nullptr) == 42);
            CHECK(hook_cef_browser_host_create_browser(nullptr, &clientB, nullptr, nullptr, nullptr, nullptr) == 42);
            auto a = clientA.get_load_handler(&clientA);
            auto b = clientB.get_load_handler(&clientB);
            a->on_load_end(a, nullptr, &frame, 200);
            b->on_load_end(b, nullptr, &frame, 200);
            a->on_load_start(a, nullptr, &frame, TT_EXPLICIT); // null original start
        }
        CHECK(callsA == 5 && callsB == 5 && scripts == 15);
        CHECK(clientA.get_request_handler != nullptr);
        auto* standaloneAiRequestHandler = clientA.get_request_handler(&clientA);
        CHECK(standaloneAiRequestHandler && standaloneAiRequestHandler->get_resource_request_handler);
        CHECK(standaloneAiRequestHandler->base.release(&standaloneAiRequestHandler->base) == 1);
        CHECK(frameRefs == 1);
        CHECK(loadA.base.release(&loadA.base) == 1);
        init(loadA); loadA.on_load_end = endB; // Reuse same address after destruction.
        clientA.get_load_handler(&clientA)->on_load_end(&loadA, nullptr, &frame, 200);
        CHECK(callsA == 5 && callsB == 6);
        cef_load_handler_t consumes{}; init(consumes); consumes.on_load_end = endConsumesFrame;
        InstanceHooks<cef_load_handler_t>::install(&consumes, [](cef_load_handler_t* h) { h->on_load_end = hook_cef_on_load_end; });
        int before = scripts;
        consumes.on_load_end(&consumes, nullptr, &frame, 200);
        CHECK(scripts == before + 1 && frameRefs == 0); // Held until dispatch completes.
        consumes.base.release(&consumes.base);
        frameRefs = 1;
        init(consumes); consumes.on_load_end = endClosesFrame;
        InstanceHooks<cef_load_handler_t>::install(&consumes, [](cef_load_handler_t* h) { h->on_load_end = hook_cef_on_load_end; });
        before = scripts;
        consumes.on_load_end(&consumes, nullptr, &frame, 200);
        CHECK(scripts == before && frameRefs == 1); // Detached frame receives no script.
        ExecJs(&frame, L"test"); CHECK(scripts == before);
        consumes.base.release(&consumes.base); detached = false;
        CHECK(!InstanceHooks<cef_load_handler_t>::install(nullptr, [](cef_load_handler_t*) {}));
        cef_load_handler_t incompatible{}; incompatible.base.size = sizeof(cef_base_ref_counted_t);
        CHECK(!InstanceHooks<cef_load_handler_t>::install(&incompatible, [](cef_load_handler_t*) {}));
        cef_keyboard_handler_t keys{}; init(keys);
        keys.on_pre_key_event = originalPreKey;
        InstanceHooks<cef_keyboard_handler_t>::install(&keys, [](cef_keyboard_handler_t* h) { h->on_key_event = hook_cef_on_key_event; h->on_pre_key_event = hook_cef_on_pre_key_event; });
        cef_key_event_t event{}; event.type = KEYEVENT_KEYUP;
        CHECK(keys.on_key_event(&keys, nullptr, &event, nullptr) == 0);
        cef_browser_t shortcutBrowser{}; init(shortcutBrowser); shortcutBrowser.get_main_frame = shortcutMain;
        shortcutFrame = &frame; captureScripts = true; const int beforeShortcut = scripts;
        event.type = KEYEVENT_RAWKEYDOWN; event.windows_key_code = 'G'; event.modifiers = EVENTFLAG_CONTROL_DOWN;
        int shortcut = 0;
        CHECK(keys.on_pre_key_event(&keys, &shortcutBrowser, &event, nullptr, &shortcut) == 1);
        CHECK(shortcut == 1 && scripts == beforeShortcut + 1 && frameRefs == 1 && preKeyCalls == 0);
        CHECK(injected.back().find(L"toggleSettings()") != std::wstring::npos);
        event.native_key_code = 1u << 30;
        CHECK(keys.on_pre_key_event(&keys, &shortcutBrowser, &event, nullptr, &shortcut) == 1);
        CHECK(scripts == beforeShortcut + 1); // Holding Ctrl+G never flickers.
        event.native_key_code = 0; event.modifiers |= EVENTFLAG_SHIFT_DOWN;
        CHECK(keys.on_pre_key_event(&keys, &shortcutBrowser, &event, nullptr, &shortcut) == 7);
        event.modifiers = EVENTFLAG_CONTROL_DOWN;
        CHECK(keys.on_pre_key_event(&keys, nullptr, &event, nullptr, &shortcut) == 7);
        detached = true;
        CHECK(keys.on_pre_key_event(&keys, &shortcutBrowser, &event, nullptr, &shortcut) == 7);
        CHECK(frameRefs == 1 && preKeyCalls == 3);
        detached = false; captureScripts = false; injected.clear(); shortcutFrame = nullptr;
        std::cout << "PASS: native Ctrl+G targets main frame, consumes once before DOM, ignores repeat and preserves original callbacks/refcounts\n";
        keys.base.release(&keys.base);
        loadA.base.release(&loadA.base); loadB.base.release(&loadB.base);
        clientA.base.release(&clientA.base); clientB.base.release(&clientB.base);
        for (int i = 1; i <= 70; ++i) RememberKeyboardHook(WH_KEYBOARD_LL, reinterpret_cast<HHOOK>(i));
        RememberKeyboardHook(WH_KEYBOARD_LL, reinterpret_cast<HHOOK>(1));
        CHECK(g_keyboard_hooks.size() == 70);
        g_keyboard_hooks.clear();
        // Exercise the actual native resource loader and complete chunked transport.
        // No external scripts are present in this test's working directory.
        CHECK(GetFileAttributesW(L"gm_shim.js") == INVALID_FILE_ATTRIBUTES);
        CHECK(GetFileAttributesW(L"dat.js") == INVALID_FILE_ATTRIBUTES);
        const auto shim = LoadEmbeddedUserScript(IDR_GM_SHIM_SCRIPT);
        const auto dat = LoadEmbeddedUserScript(IDR_DAT_SCRIPT);
        CHECK(!shim.empty() && dat.size() > 100000);
        CHECK(LoadEmbeddedUserScript(65535).empty());
        CHECK(shim.find(L"window.__cefUserScriptMetadata=") == 0);
        CHECK(dat.find(L"CEF_SCRIPT_PAIR_MISMATCH") != std::wstring::npos);
        frame.is_main = isMain; captureScripts = true;
        InjectUserScript(&frame);
        std::vector<std::wstring> payloads;
        std::wstring payload;
        const std::wstring prefix = L"if(window.__cefInjectionAllowed)window.__wnB+=\"";
        for (const auto& js : injected) {
            if (js == L"window.__wnB='';") payload.clear();
            else if (js.compare(0, prefix.size(), prefix) == 0) {
                CHECK(js.size() - prefix.size() - 2 <= 8000);
                payload += js.substr(prefix.size(), js.size() - prefix.size() - 2);
            } else if (js.find(L"decodeURIComponent(escape(atob(window.__wnB)))") != std::wstring::npos)
                payloads.push_back(payload);
        }
        CHECK(payloads.size() == 2);
        CHECK(payloads[0] == Base64EncodeUtf8(shim));
        CHECK(payloads[1] == Base64EncodeUtf8(WrapUserScript(dat)));
        CHECK(frameRefs == 1);
        // Fail closed on damaged compressed blocks, headers, sizes, or digests.
        HMODULE module = nullptr;
        CHECK(GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
            reinterpret_cast<LPCWSTR>(&LoadEmbeddedUserScript), &module));
        auto resource = FindResourceW(module, MAKEINTRESOURCEW(IDR_DAT_SCRIPT), RT_RCDATA);
        auto block = static_cast<const unsigned char*>(LockResource(LoadResource(module, resource)));
        std::vector<unsigned char> packet(block, block + SizeofResource(module, resource));
        std::string decoded;
        CHECK(DecodeScriptPacket(packet.data(), packet.size(), decoded));
        packet[8] ^= 1; CHECK(!DecodeScriptPacket(packet.data(), packet.size(), decoded) && decoded.empty());
        packet[8] ^= 1; packet[0] ^= 1; CHECK(!DecodeScriptPacket(packet.data(), packet.size(), decoded));
        packet[0] ^= 1; std::memset(packet.data() + 4, 0xff, 4);
        CHECK(!DecodeScriptPacket(packet.data(), packet.size(), decoded));
        std::wstring unicode;
        CHECK(ScriptUtf8ToWide("\xe6\xb5\x8b\xe8\xaf\x95", unicode) && unicode == L"测试");
        CHECK(!ScriptUtf8ToWide(std::string("\xc3(", 2), unicode) && unicode.empty());
        CHECK(AiConfigPrelude("\";window.pwned=true;//").find(L"window.pwned") == std::wstring::npos);
        CHECK(AiConfigPrelude("{\"apiKey\":\"fixture-only\"}").find(L"fixture-only") == std::wstring::npos);
        CHECK(AiConfigPrelude(std::string(65537, 'x')) == L"window.__CX_AI_CONFIG__={};");
        CHECK(ReadAiConfigFile(L"nonexistent-ai-config-fixture.json").find(L"JSON.parse") != std::wstring::npos);
        wchar_t tempPath[MAX_PATH]{}, tempFile[MAX_PATH]{};
        CHECK(GetTempPathW(_countof(tempPath), tempPath) > 0);
        CHECK(GetTempFileNameW(tempPath, L"cxa", 0, tempFile) != 0);
        CHECK(WriteAiConfigFile(tempFile, "{\"enabled\":true,\"apiKey\":\"fixture-persisted\"}"));
        const auto savedPrelude = ReadAiConfigFile(tempFile);
        CHECK(savedPrelude.find(L"JSON.parse") != std::wstring::npos);
        CHECK(savedPrelude.find(L"fixture-persisted") == std::wstring::npos);
        CHECK(!WriteAiConfigFile(tempFile, "not-json"));
        DeleteFileW(tempFile);
        CHECK(shim.find(L"__cefDeepSeek") != std::wstring::npos);
        CHECK(IsAllowedAiProxyRouteForTest(
            L"https://mooc1.chaoxing.com/__cef_cx_ai_proxy__/health",
            L"https://mooc1.chaoxing.com", L"GET"));
        CHECK(IsAllowedAiProxyRouteForTest(
            L"https://school.edu.cn/__cef_cx_ai_proxy__/chat/completions",
            L"https://school.edu.cn", L"POST"));
        CHECK(IsAllowedAiProxyRouteForTest(
            L"https://mooc1.chaoxing.com/__cef_cx_ai_proxy__/config",
            L"https://mooc1.chaoxing.com", L"POST"));
        CHECK(!IsAllowedAiProxyRouteForTest(
            L"https://mooc1.chaoxing.com/__cef_cx_ai_proxy__/config",
            L"https://mooc1.chaoxing.com", L"GET"));
        CHECK(!IsAllowedAiProxyRouteForTest(
            L"https://evil.example/__cef_cx_ai_proxy__/chat/completions",
            L"https://evil.example", L"POST"));
        CHECK(!IsAllowedAiProxyRouteForTest(
            L"https://mooc1.chaoxing.com/__cef_cx_ai_proxy__/chat/completions",
            L"https://other.chaoxing.com", L"POST"));
        CHECK(IsAllowedDeepSeekTargetForTest(L"https://api.deepseek.com/chat/completions"));
        CHECK(IsAllowedDeepSeekTargetForTest(L"https://api.deepseek.com/v1/chat/completions"));
        CHECK(!IsAllowedDeepSeekTargetForTest(L"https://127.0.0.1/chat/completions"));
        CHECK(!IsAllowedDeepSeekTargetForTest(L"https://api.deepseek.com.evil.example/chat/completions"));
        auto* nativeRequestHandler = CreateNativeAiRequestHandler();
        CHECK(nativeRequestHandler && nativeRequestHandler->get_resource_request_handler);
        CHECK(nativeRequestHandler->base.release(&nativeRequestHandler->base) == 1);
        std::cout << "PASS: native AI proxy is same-origin exam-only and official-DeepSeek-only; arbitrary SSRF targets rejected\n";
        std::cout << "PASS: bounded optional AI config; UTF-16 escaping prevents config source execution\n";

        // Duplicate load_end must not retransmit the main payload. A load_start
        // (including a reload to the same URL) must permit a fresh full injection.
        auto chunkCount = [] {
            size_t count = 0;
            for (const auto& js : injected) if (js.find(L"window.__wnB+=") != std::wstring::npos) ++count;
            return count;
        };
        injected.clear(); g_frameDocuments.start(&frame, nullptr);
        hook_cef_on_load_end(&loadA, nullptr, &frame, 200);
        const size_t firstChunks = chunkCount(); CHECK(firstChunks > 1);
        hook_cef_on_load_end(&loadA, nullptr, &frame, 200);
        CHECK(chunkCount() == firstChunks);
        hook_cef_on_load_start(&loadA, nullptr, &frame, TT_EXPLICIT);
        hook_cef_on_load_end(&loadA, nullptr, &frame, 200);
        CHECK(chunkCount() == firstChunks * 2);
        captureScripts = false;
        std::cout << "PASS: compressed resource corruption rejection; duplicate load_end sends no chunks; new document reinjects\n";
        std::cout << "PASS: embedded GM/dat resources, UTF-8 decoding, shim-first full chunk transport, no external JS\n";
        const std::wstring native = NativeDiagnosticsJson();
        CHECK(native.find(L"\"architecture\":\"x86\"") != std::wstring::npos);
        CHECK(native.find(L"\"lifecycle\"") != std::wstring::npos);
        CHECK(native.find(L"\"hooks\"") != std::wstring::npos);
        CHECK(native.find(L"\"crashDump\"") != std::wstring::npos);
        std::cout << "PASS: callback isolation, repeated install, original load chain, address reuse, null callbacks, ABI guard, hook capacity\n";
        return 0;
    } catch (const std::exception& e) { std::cerr << e.what() << '\n'; return 1; }
}
