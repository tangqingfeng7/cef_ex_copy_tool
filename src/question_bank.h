#pragma once
#include <windows.h>
#include <atomic>
#include <string>

// Called by the worker after startup, outside the Windows loader lock.
void InitializeQuestionBank();

// Local-only JSON API, always using question-bank.db alongside this DLL.
std::string HandleQuestionBankRequest(const std::string& body,
                                     const std::atomic<bool>& canceled);
