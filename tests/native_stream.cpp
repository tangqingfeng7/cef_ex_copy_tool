#include <windows.h>
#include <iostream>
#include <stdexcept>
#include "../src/ai_stream_buffer.h"
#define CHECK(x) do { if (!(x)) throw std::runtime_error(#x); } while (0)
struct Callback {
    cef_resource_read_callback_t api{};
    int refs = 1, calls = 0, bytes = -999;
    Callback() {
        api.base.size = sizeof(api);
        api.base.add_ref = [](cef_base_ref_counted_t* p) { ++reinterpret_cast<Callback*>(p)->refs; };
        api.base.release = [](cef_base_ref_counted_t* p) -> int { return --reinterpret_cast<Callback*>(p)->refs == 0; };
        api.cont = [](cef_resource_read_callback_t* p, int n) { auto* s = reinterpret_cast<Callback*>(p); ++s->calls; s->bytes = n; };
    }
};
int main() {
    try {
        char out[16]{}; int n = -1; Callback callback;
        AiStreamBuffer stream;
        CHECK(stream.read(out, sizeof(out), &n, &callback.api) == 1 && n == 0 && callback.refs == 2);
        CHECK(stream.push(reinterpret_cast<const unsigned char*>("first"), 5));
        CHECK(callback.calls == 1 && callback.bytes == 5 && callback.refs == 1 && std::string(out, 5) == "first");
        CHECK(stream.push(reinterpret_cast<const unsigned char*>("second"), 6));
        CHECK(stream.read(out, 3, &n, &callback.api) == 1 && n == 3 && std::string(out, 3) == "sec");
        CHECK(stream.read(out, 16, &n, &callback.api) == 1 && n == 3 && std::string(out, 3) == "ond");
        CHECK(stream.read(out, 16, &n, &callback.api) == 1 && n == 0);
        stream.finish(); CHECK(callback.calls == 2 && callback.bytes == 0 && callback.refs == 1);
        CHECK(stream.read(out, 16, &n, &callback.api) == 0 && n == 0);
        AiStreamBuffer canceled; Callback cancel;
        CHECK(canceled.read(out, 16, &n, &cancel.api) == 1 && cancel.refs == 2);
        canceled.cancel(); CHECK(cancel.refs == 1 && cancel.calls == 0);
        CHECK(!canceled.push(reinterpret_cast<const unsigned char*>("ignored"), 7));
        AiStreamBuffer failed; Callback error;
        CHECK(failed.read(out, 16, &n, &error.api) == 1); failed.finish(true);
        CHECK(error.bytes == -2 && error.refs == 1);
        AiStreamBuffer bounded;
        std::vector<unsigned char> large(16u * 1024u * 1024u, 'x');
        CHECK(bounded.push(large.data(), large.size())); CHECK(!bounded.push(large.data(), 1));
        std::cout << "PASS: native stream first bytes before EOF, deferred Read copies before cont, split reads, EOF/error, cancellation refs, 16 MiB bound\n";
        return 0;
    } catch (const std::exception& e) { std::cerr << e.what() << '\n'; return 1; }
}
