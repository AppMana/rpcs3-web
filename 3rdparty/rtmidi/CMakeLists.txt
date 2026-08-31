if(USE_SYSTEM_RTMIDI)
  message(STATUS "RPCS3: using shared RtMidi")
  pkg_check_modules(RtMidi REQUIRED IMPORTED_TARGET rtmidi>=6.0.0)
  add_library(rtmidi INTERFACE)
  target_link_libraries(rtmidi INTERFACE PkgConfig::RtMidi)
  target_include_directories(rtmidi SYSTEM INTERFACE PkgConfig::RtMidi)
else()
  option(RTMIDI_API_JACK "Compile with JACK support." OFF)
  option(RTMIDI_BUILD_TESTING "Build test programs" OFF)
  set(RTMIDI_TARGETNAME_UNINSTALL "uninstall-rpcs3-rtmidi")
  add_subdirectory(rtmidi EXCLUDE_FROM_ALL)

  # RtMidi already ships a Web MIDI implementation, but its upstream CMake
  # project does not currently select it for Emscripten.  Keep RPCS3's MIDI
  # device code intact and bind it to the browser API instead of compiling a
  # desktop ALSA/JACK backend into the Web build.
  if(EMSCRIPTEN)
    target_compile_definitions(rtmidi PRIVATE __WEB_MIDI_API__)
  endif()
endif()
