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
file(GLOB _script_assets CONFIGURE_DEPENDS "${CMAKE_SOURCE_DIR}/scripts/assets/*")
add_custom_command(OUTPUT "${CMAKE_SOURCE_DIR}/out/js/build.stamp"
    COMMAND "${NODE_EXECUTABLE}" "${CMAKE_SOURCE_DIR}/tools/transpile/build.js"
    DEPENDS "${CMAKE_SOURCE_DIR}/scripts/dat.js" "${CMAKE_SOURCE_DIR}/scripts/gm_shim.js"
        "${CMAKE_SOURCE_DIR}/scripts/deepseek.js"
        "${CMAKE_SOURCE_DIR}/scripts/deepseek_ai_script.js"
        "${CMAKE_SOURCE_DIR}/tools/transpile/build.js" "${CMAKE_SOURCE_DIR}/tools/transpile/babel.config.json"
        "${CMAKE_SOURCE_DIR}/tools/transpile/package-lock.json" "${CMAKE_SOURCE_DIR}/tools/resource-codec.ps1"
        "${CMAKE_SOURCE_DIR}/tools/build-info.cjs" ${_script_assets}
    BYPRODUCTS "${CMAKE_SOURCE_DIR}/out/js/dat.js"
        "${CMAKE_SOURCE_DIR}/out/js/gm_shim.js"
        "${CMAKE_SOURCE_DIR}/out/js/metadata.json"
        "${CMAKE_SOURCE_DIR}/out/js/dat.bin" "${CMAKE_SOURCE_DIR}/out/js/gm_shim.bin"
    COMMENT "Building compressed userscripts with pinned offline assets"
    VERBATIM)
add_custom_target(userscript_build DEPENDS "${CMAKE_SOURCE_DIR}/out/js/build.stamp")
configure_file(userscript_resources.rc.in
    "${CMAKE_CURRENT_BINARY_DIR}/generated/userscript_resources.rc" @ONLY)
set(_userscript_resources "${CMAKE_CURRENT_BINARY_DIR}/generated/userscript_resources.rc")
set_source_files_properties("${_userscript_resources}" PROPERTIES
    OBJECT_DEPENDS "${CMAKE_SOURCE_DIR}/out/js/dat.bin;${CMAKE_SOURCE_DIR}/out/js/gm_shim.bin")
target_sources(CefHook PRIVATE "${_userscript_resources}")
add_custom_target(build_info
    # Cheap content cache also catches Git-only changes and repairs missing outputs.
    COMMAND "${NODE_EXECUTABLE}" "${CMAKE_SOURCE_DIR}/tools/transpile/build.js"
    COMMAND "${NODE_EXECUTABLE}" "${CMAKE_SOURCE_DIR}/tools/build-info.cjs"
        "${CMAKE_CURRENT_BINARY_DIR}/generated" "$<CONFIG>"
    BYPRODUCTS "${CMAKE_CURRENT_BINARY_DIR}/generated/build_info.h"
        "${CMAKE_CURRENT_BINARY_DIR}/generated/clipboard_repair.h"
    COMMENT "Fingerprinting DLL sources and Git revision"
    VERBATIM)
add_dependencies(CefHook build_info)
add_dependencies(build_info userscript_build)
set_target_properties(CefHook PROPERTIES
    LINKER_LANGUAGE C
    OUTPUT_NAME "winmm"
    PREFIX ""
)
target_include_directories(CefHook PRIVATE ${DETOURS_INCLUDE_DIRS})
target_link_libraries(CefHook PRIVATE ${DETOURS_LIBRARY} Dbghelp Shell32 Cabinet Bcrypt Winhttp)

target_include_directories(CefHook PRIVATE "${CMAKE_CURRENT_BINARY_DIR}/generated")
if(MSVC)
    # Only units that actually include build_info.h depend on source fingerprints.
    target_compile_options(CefHook PRIVATE /utf-8 /Zi /EHsc)
    target_link_options(CefHook PRIVATE /DEBUG /INCREMENTAL:NO)
endif()
if(BUILD_TESTING)
    add_executable(native_callbacks "${CMAKE_SOURCE_DIR}/tests/native_callbacks.cpp" crash_dump.cpp ai_native_proxy.cpp)
    target_sources(native_callbacks PRIVATE "${_userscript_resources}")
    add_dependencies(native_callbacks build_info)
    target_include_directories(native_callbacks PRIVATE ${DETOURS_INCLUDE_DIRS} "${CMAKE_CURRENT_BINARY_DIR}/generated")
    target_link_libraries(native_callbacks PRIVATE ${DETOURS_LIBRARY} Shlwapi Dbghelp Shell32 Cabinet Bcrypt Winhttp)
    target_compile_options(native_callbacks PRIVATE /utf-8 /EHsc)
    add_test(NAME native_callbacks COMMAND native_callbacks)
    add_executable(script_cache "${CMAKE_SOURCE_DIR}/tests/script_cache.cpp")
    target_compile_options(script_cache PRIVATE /utf-8)
    add_test(NAME script_cache COMMAND script_cache)
    add_executable(crash_dump_test "${CMAKE_SOURCE_DIR}/tests/crash_dump.cpp" crash_dump.cpp)
    add_dependencies(crash_dump_test build_info)
    target_include_directories(crash_dump_test PRIVATE "${CMAKE_CURRENT_BINARY_DIR}/generated")
    target_link_libraries(crash_dump_test PRIVATE Dbghelp Shell32)
    target_compile_options(crash_dump_test PRIVATE /utf-8)
    add_test(NAME crash_dump COMMAND crash_dump_test)
endif()
