#pragma once
#include "include/capi/cef_frame_capi.h"

// Original callbacks may release their wrapper or trigger navigation. Retain the
// frame across the complete hook, then recheck attachment before each dispatch.
class ScopedCefFrame {
    cef_frame_t* frame_;
public:
    explicit ScopedCefFrame(cef_frame_t* frame) : frame_(frame) {
        if (frame_ && frame_->base.add_ref && frame_->base.release)
            frame_->base.add_ref(&frame_->base);
        else frame_ = nullptr;
    }
    ~ScopedCefFrame() { if (frame_) frame_->base.release(&frame_->base); }
    ScopedCefFrame(const ScopedCefFrame&) = delete;
    ScopedCefFrame& operator=(const ScopedCefFrame&) = delete;
    cef_frame_t* get() const { return frame_; }
};
inline bool FrameCanExecute(cef_frame_t* frame) {
    return frame && frame->is_valid && frame->is_valid(frame) && frame->execute_java_script;
}
