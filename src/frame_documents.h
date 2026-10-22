#pragma once
#include <map>
#include <mutex>
#include <tuple>
#include <cstdint>

// Bounded per-document state: same URL reloads are new documents; URL is never a key.
// Only called with a retained, valid main frame on CEF load callbacks.
class FrameDocuments {
    using Key = std::tuple<int, int64_t, uintptr_t>;
    struct Record { unsigned long long generation = 0; bool sent = false; };
    std::mutex mutex_;
    std::map<Key, Record> records_;
    unsigned long long generation_ = 0, skipped_ = 0;
    static Key key(cef_frame_t* frame, cef_browser_t* browser) {
        return Key(browser && browser->get_identifier ? browser->get_identifier(browser) : 0,
            frame->get_identifier ? frame->get_identifier(frame) : 0,
            frame->get_identifier ? 0 : reinterpret_cast<uintptr_t>(frame));
    }
public:
    void start(cef_frame_t* frame, cef_browser_t* browser) {
        std::lock_guard<std::mutex> lock(mutex_);
        if (records_.size() >= 2048) records_.clear();
        records_[key(frame, browser)] = Record{++generation_, false};
    }
    bool begin(cef_frame_t* frame, cef_browser_t* browser, unsigned long long& generation) {
        std::lock_guard<std::mutex> lock(mutex_);
        auto k = key(frame, browser);
        if (records_.size() >= 2048 && !records_.count(k)) records_.clear();
        auto& record = records_[k];
        if (!record.generation) record.generation = ++generation_;
        generation = record.generation;
        if (record.sent) { ++skipped_; return false; }
        record.sent = true; return true;
    }
    unsigned long long skipped() { std::lock_guard<std::mutex> lock(mutex_); return skipped_; }
};
