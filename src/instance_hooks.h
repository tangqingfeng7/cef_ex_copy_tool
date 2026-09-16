#pragma once
#include <map>
#include <mutex>
#include "include/capi/cef_base_capi.h"

// Each CEF instance owns its original callbacks. Remove records on final release
// so an allocator reusing the same address cannot inherit another object's hooks.
template<class T> class InstanceHooks {
    struct State {
        std::recursive_mutex mutex;
        std::map<T*, T> originals;
    };
    static State& state() { static State s; return s; }
    static int CEF_CALLBACK release(cef_base_ref_counted_t* base) {
        auto& s = state();
        std::lock_guard<std::recursive_mutex> lock(s.mutex);
        auto* self = reinterpret_cast<T*>(base);
        auto it = s.originals.find(self);
        if (it == s.originals.end()) return 0;
        auto original = it->second.base.release;
        int deleted = original(base);
        // No access to self after original release: the object may be freed.
        if (deleted) s.originals.erase(self);
        return deleted;
    }
public:
    template<class Patch> static bool install(T* self, Patch patch) {
        if (!self || self->base.size < sizeof(T) || !self->base.release) return false;
        auto& s = state();
        std::lock_guard<std::recursive_mutex> lock(s.mutex);
        if (s.originals.count(self)) return true;
        s.originals.emplace(self, *self);
        patch(self);
        self->base.release = release;
        return true;
    }
    static T original(T* self) {
        auto& s = state();
        std::lock_guard<std::recursive_mutex> lock(s.mutex);
        auto it = s.originals.find(self);
        return it == s.originals.end() ? T{} : it->second;
    }
};
