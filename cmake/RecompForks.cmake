# Recompiler forks are developed as sibling checkouts under AppMana and pinned
# for release builds. CMake consumes source directories directly, so a
# developer can replace any pinned submodule path with a symlink to a fork
# checkout without changing the build graph.
set(RPCS3_RECOMP_FORKS_DIR "" CACHE PATH
	"Directory containing AppMana forks-* checkouts for AOT development")

function(rpcs3_recomp_fork_path out_var fork_name)
	if(RPCS3_RECOMP_FORKS_DIR)
		set(_fork_path "${RPCS3_RECOMP_FORKS_DIR}/${fork_name}")
	else()
		set(_fork_path "${CMAKE_SOURCE_DIR}/3rdparty/recomp/${fork_name}")
	endif()

	set(${out_var} "${_fork_path}" PARENT_SCOPE)
endfunction()

rpcs3_recomp_fork_path(RPCS3_PS3RECOMP_FORK_DIR forks-ps3recomp)
rpcs3_recomp_fork_path(RPCS3_XENONRECOMP_FORK_DIR forks-XenonRecomp)

if(EXISTS "${RPCS3_PS3RECOMP_FORK_DIR}/CMakeLists.txt")
	message(STATUS "RPCS3: using ps3recomp fork at ${RPCS3_PS3RECOMP_FORK_DIR}")
endif()

if(EXISTS "${RPCS3_XENONRECOMP_FORK_DIR}/CMakeLists.txt")
	message(STATUS "RPCS3: using XenonRecomp fork at ${RPCS3_XENONRECOMP_FORK_DIR}")
endif()
