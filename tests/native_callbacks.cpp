#include <stdexcept>
#include <iostream>
#include "../src/thread.cpp"

#define CHECK(x) do { if (!(x)) throw std::runtime_error(#x); } while (0)
static int callsA = 0, callsB = 0, scripts = 0;
static int frameRefs = 1;
static bool detached = false;
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
static int createFake(const cef_window_info_t*, cef_client_t*, const cef_string_t*,
    const cef_browser_settings_t*, cef_dictionary_value_t*, cef_request_context_t*) { return 42; }
static void CEF_CALLBACK execFake(cef_frame_t*, const cef_string_t*, const cef_string_t*, int) {
    CHECK(frameRefs > 0 && !detached); ++scripts;
}
static void CEF_CALLBACK endConsumesFrame(cef_load_handler_t*, cef_browser_t*, cef_frame_t* frame, int) {
    frame->base.release(&frame->base);
}
static void CEF_CALLBACK endClosesFrame(cef_load_handler_t*, cef_browser_t*, cef_frame_t*, int) { detached = true; }
static int CEF_CALLBACK notMain(cef_frame_t*) { return 0; }
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
        InstanceHooks<cef_keyboard_handler_t>::install(&keys, [](cef_keyboard_handler_t* h) { h->on_key_event = hook_cef_on_key_event; });
        cef_key_event_t event{}; event.type = KEYEVENT_KEYUP;
        CHECK(keys.on_key_event(&keys, nullptr, &event, nullptr) == 0);
        keys.base.release(&keys.base);
        loadA.base.release(&loadA.base); loadB.base.release(&loadB.base);
        clientA.base.release(&clientA.base); clientB.base.release(&clientB.base);
        for (int i = 1; i <= 70; ++i) RememberKeyboardHook(WH_KEYBOARD_LL, reinterpret_cast<HHOOK>(i));
        RememberKeyboardHook(WH_KEYBOARD_LL, reinterpret_cast<HHOOK>(1));
        CHECK(g_keyboard_hooks.size() == 70);
        g_keyboard_hooks.clear();
        const std::wstring native = NativeDiagnosticsJson();
        CHECK(native.find(L"\"architecture\":\"x86\"") != std::wstring::npos);
        CHECK(native.find(L"\"lifecycle\"") != std::wstring::npos);
        CHECK(native.find(L"\"hooks\"") != std::wstring::npos);
        CHECK(native.find(L"\"crashDump\"") != std::wstring::npos);
        std::cout << "PASS: callback isolation, repeated install, original load chain, address reuse, null callbacks, ABI guard, hook capacity\n";
        return 0;
    } catch (const std::exception& e) { std::cerr << e.what() << '\n'; return 1; }
}
