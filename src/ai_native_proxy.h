#pragma once

#include <string>
#include "include/capi/cef_request_handler_capi.h"

// The exam page may forbid cross-origin fetch with connect-src CSP. This
// browser-process resource handler accepts a same-origin marker request and
// forwards only the official DeepSeek Chat Completions endpoint via WinHTTP.
// It does not disable CORS/CSP globally and it never permits arbitrary URLs.
cef_request_handler_t* CreateNativeAiRequestHandler();
void InstallNativeAiRequestHandlerHooks(cef_request_handler_t* handler);

// Pure validation surface used by native tests.
bool IsAllowedAiProxyRouteForTest(const std::wstring& requestUrl,
                                  const std::wstring& initiator,
                                  const std::wstring& method);
bool IsAllowedDeepSeekTargetForTest(const std::wstring& target);
