#!/usr/bin/env bash
set -euo pipefail

build_root="$1"
cc="$2"

version="8.1.1"
sha256="b6863adde98898f42602017462871b5f6333e65aec803fdd7a6308639c52edf3"
deps_dir="${build_root}/_deps"
archive="${deps_dir}/ffmpeg-${version}.tar.xz"
source_dir="${deps_dir}/ffmpeg-${version}"
build_dir="${deps_dir}/ffmpeg-${version}-build"
install_dir="${deps_dir}/ffmpeg-${version}-install"
tool_dir="$(dirname "${cc}")"

mkdir -p "${deps_dir}" "${build_dir}" "${install_dir}"

if [[ ! -x "${source_dir}/configure" ]]; then
	curl -fL "https://ffmpeg.org/releases/ffmpeg-${version}.tar.xz" -o "${archive}"
	printf '%s  %s\n' "${sha256}" "${archive}" | sha256sum --check --status
	tar -xf "${archive}" -C "${deps_dir}"
fi

if [[ ! -f "${build_dir}/Makefile" ]]; then
	(
		cd "${build_dir}"
		"${source_dir}/configure" \
			--prefix="${install_dir}" \
			--cc="${cc}" \
			--cxx="${tool_dir}/em++" \
			--ar="${tool_dir}/emar" \
			--ranlib="${tool_dir}/emranlib" \
			--nm="${tool_dir}/emnm" \
			--arch=wasm32 \
			--target-os=none \
			--enable-cross-compile \
			--enable-static \
			--disable-shared \
			--disable-programs \
			--disable-doc \
			--disable-debug \
			--disable-autodetect \
			--disable-network \
			--disable-avdevice \
			--disable-avfilter \
			--disable-x86asm \
			--disable-everything \
			--enable-pthreads \
			--enable-protocol=file \
			--enable-decoder=aac,ac3,atrac3,atrac3al,atrac3p,h264,mjpeg,mp1,mp2,mp3,mpeg1video,mpeg2video,mpeg4,vc1,wmav1,wmav2 \
			--enable-encoder=aac,mjpeg,mpeg4,pcm_f32be,pcm_mulaw \
			--enable-demuxer=aac,ac3,avi,h264,matroska,mov,mp3,mpegps,mpegts,mpegvideo,oma,wav \
			--enable-muxer=avi,matroska,matroska_audio,mov,mp4,mpegts,wav \
			--enable-parser=aac,aac_latm,ac3,h264,mjpeg,mpegaudio,mpeg4video,mpegvideo,vc1 \
			--enable-swresample \
			--enable-swscale \
			--extra-cflags='-O3 -pthread -msimd128' \
			--extra-cxxflags='-O3 -pthread -msimd128' \
			--extra-ldflags='-pthread'
	)
fi

make -C "${build_dir}" -j"${CMAKE_BUILD_PARALLEL_LEVEL:-4}"
make -C "${build_dir}" install
