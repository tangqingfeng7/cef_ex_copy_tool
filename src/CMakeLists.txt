if(NOT CMAKE_SIZEOF_VOID_P EQUAL 4)
    message(FATAL_ERROR "This DLL requires x86. Configure Visual Studio with -A Win32.")
endif()

# Also support direct CMake/VS Code configuration without build-dll.ps1 arguments.
set(_detours_roots
    "${CMAKE_SOURCE_DIR}/vcpkg_installed/x86-windows"
    "${CMAKE_SOURCE_DIR}/out/build/x86-Release/vcpkg_installed/x86-windows")
find_path(DETOURS_INCLUDE_DIRS "detours/detours.h"
    HINTS ${_detours_roots} PATH_SUFFIXES include REQUIRED)
find_library(DETOURS_LIBRARY NAMES detours
    HINTS ${_detours_roots} PATH_SUFFIXES lib REQUIRED)

file(GLOB SOURCES CONFIGURE_DEPENDS "*.cpp" "*.c")
add_library(CefHook SHARED ${SOURCES} version.rc)
find_program(NODE_EXECUTABLE NAMES node REQUIRED)
add_custom_target(build_info
    COMMAND "${NODE_EXECUTABLE}" "${CMAKE_SOURCE_DIR}/tools/build-info.cjs"
        "${CMAKE_CURRENT_BINARY_DIR}/generated" "$<CONFIG>"
    BYPRODUCTS "${CMAKE_CURRENT_BINARY_DIR}/generated/build_info.h"
        "${CMAKE_CURRENT_BINARY_DIR}/generated/clipboard_repair.h"
    COMMENT "Fingerprinting DLL sources and Git revision"
    VERBATIM)
add_dependencies(CefHook build_info)
set_target_properties(CefHook PROPERTIES
    LINKER_LANGUAGE C
    OUTPUT_NAME "winmm"
    PREFIX ""
)
target_include_directories(CefHook PRIVATE ${DETOURS_INCLUDE_DIRS})
target_link_libraries(CefHook PRIVATE ${DETOURS_LIBRARY})

target_include_directories(CefHook PRIVATE "${CMAKE_CURRENT_BINARY_DIR}/generated")
if(MSVC)
    # Changing the fingerprint invalidates every native translation unit.
    target_compile_options(CefHook PRIVATE /utf-8 /Zi
        "$<$<COMPILE_LANGUAGE:C,CXX>:/FI${CMAKE_CURRENT_BINARY_DIR}/generated/build_info.h>")
    target_link_options(CefHook PRIVATE /DEBUG /INCREMENTAL:NO)
endif()
if(BUILD_TESTING)
    add_executable(native_callbacks "${CMAKE_SOURCE_DIR}/tests/native_callbacks.cpp")
    add_dependencies(native_callbacks build_info)
    target_include_directories(native_callbacks PRIVATE ${DETOURS_INCLUDE_DIRS} "${CMAKE_CURRENT_BINARY_DIR}/generated")
    target_link_libraries(native_callbacks PRIVATE ${DETOURS_LIBRARY} Shlwapi)
    target_compile_options(native_callbacks PRIVATE /utf-8)
    add_test(NAME native_callbacks COMMAND native_callbacks)
endif()
