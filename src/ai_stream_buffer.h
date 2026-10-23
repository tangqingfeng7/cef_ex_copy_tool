#pragma once
#include <algorithm>
#include <cstring>
#include <mutex>
#include <vector>
#include "include/capi/cef_resource_handler_capi.h"

// Bounded response storage with CEF's deferred Read contract. Pending data_out
// stays valid until cont(n); copy into it BEFORE continuing, never merely wake it.
class AiStreamBuffer {
    std::mutex mutex_;
    std::vector<unsigned char> bytes_;
    size_t offset_ = 0;
    bool done_ = false, failed_ = false, canceled_ = false;
    cef_resource_read_callback_t* waiting_ = nullptr;
    void* output_ = nullptr;
    int capacity_ = 0;
    int copy(void* out, int capacity) {
        const size_t count = (std::min)(bytes_.size() - offset_, static_cast<size_t>(capacity));
        if (count) { memcpy(out, bytes_.data() + offset_, count); offset_ += count; }
        return static_cast<int>(count);
    }
    void notify() {
        cef_resource_read_callback_t* callback = nullptr;
        int count = 0;
        {
            std::lock_guard<std::mutex> lock(mutex_);
            if (!waiting_ || canceled_ || (offset_ == bytes_.size() && !done_)) return;
            callback = waiting_; waiting_ = nullptr;
            count = copy(output_, capacity_);
            if (!count && failed_) count = -2;
            output_ = nullptr; capacity_ = 0;
        }
        if (callback->cont) callback->cont(callback, count);
        if (callback->base.release) callback->base.release(&callback->base);
    }
public:
    ~AiStreamBuffer() { cancel(); }
    bool push(const unsigned char* data, size_t size) {
        {
            std::lock_guard<std::mutex> lock(mutex_);
            if (done_ || canceled_ || size > 16u * 1024u * 1024u - bytes_.size()) return false;
            bytes_.insert(bytes_.end(), data, data + size);
        }
        notify(); return true;
    }
    void finish(bool failed = false) {
        { std::lock_guard<std::mutex> lock(mutex_); done_ = true; failed_ = failed; }
        notify();
    }
    int read(void* output, int capacity, int* count, cef_resource_read_callback_t* callback) {
        if (!count || !output || capacity <= 0) return 0;
        std::lock_guard<std::mutex> lock(mutex_);
        *count = 0;
        if (canceled_) return 0;
        *count = copy(output, capacity);
        if (*count) return 1;
        if (done_) { if (failed_) *count = -2; return 0; }
        if (!callback || waiting_) { *count = -2; return 0; }
        waiting_ = callback; output_ = output; capacity_ = capacity;
        if (callback->base.add_ref) callback->base.add_ref(&callback->base);
        return 1;
    }
    void cancel() {
        cef_resource_read_callback_t* callback = nullptr;
        { std::lock_guard<std::mutex> lock(mutex_); canceled_ = true; callback = waiting_; waiting_ = nullptr; output_ = nullptr; }
        if (callback && callback->base.release) callback->base.release(&callback->base);
    }
};
