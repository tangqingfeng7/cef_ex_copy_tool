#pragma once

#include <string>
#include <vector>
#include "include/capi/cef_request_handler_capi.h"

// The exam page may forbid cross-origin fetch with connect-src CSP. This
// browser-process resource handler accepts a same-origin marker request and
// forwards only official DeepSeek Chat Completions (POST) and balance (GET)
// endpoints via WinHTTP, each bound to its own exact route and method.
// It does not disable CORS/CSP globally and it never permits arbitrary URLs.
cef_request_handler_t* CreateNativeAiRequestHandler();
void InstallNativeAiRequestHandlerHooks(cef_request_handler_t* handler);

// Pure validation surface used by native tests.
bool IsAllowedAiProxyRouteForTest(const std::wstring& requestUrl,
                                  const std::wstring& initiator,
                                  const std::wstring& method);
bool IsAllowedDeepSeekTargetForTest(const std::wstring& target);
bool IsAllowedDeepSeekBalanceTargetForTest(const std::wstring& target);
bool IsAllowedAiProxySourceForTest(const std::wstring& target, const std::wstring& initiator,
                                  const std::wstring& frame, const std::wstring& method, bool navigation, bool download);

bool CaptureBrowserClientForTest(void* window, std::vector<unsigned char>& bitmap);
