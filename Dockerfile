# syntax=docker/dockerfile:1
# Microgeographies — app + COLMAP (GPU) in one image.
#
# Single stage on the CUDA *devel* image on purpose: COLMAP links a long
# tail of C++ libraries, and keeping the build tools in the image is far
# more likely to work first time than hand-copying .so files into a slim
# runtime. Cost: a large image (~10 GB with the torch CUDA wheel).
#
# Build args:
#   COLMAP_VERSION  COLMAP git tag to build (default 3.9.1).
#   CUDA_ARCHS      Semicolon list for CMAKE_CUDA_ARCHITECTURES.
#                   Defaults cover V100/Turing/Ampere/Ada/Hopper
#                   (70;75;80;86;90). Narrow it to your card to compile
#                   faster, e.g. --build-arg CUDA_ARCHS=86 for Ampere.
#                   Do NOT use "native" here: image builds usually run
#                   on machines without a GPU, where it fails.
ARG CUDA_VERSION=12.6.3
ARG UBUNTU_VERSION=22.04
ARG COLMAP_VERSION=3.9.1
ARG CUDA_ARCHS=70;75;80;86;89;90

FROM nvidia/cuda:${CUDA_VERSION}-devel-ubuntu${UBUNTU_VERSION}
ARG COLMAP_VERSION
ARG CUDA_ARCHS

ENV DEBIAN_FRONTEND=noninteractive \
    TZ=Etc/UTC \
    LANG=C.UTF-8

# Python 3.11 (matches the repo's .venv) from deadsnakes, plus the C++
# toolchain and every library COLMAP/Ceres link against.
RUN apt-get update \
 && apt-get install -y --no-install-recommends software-properties-common curl git \
 && add-apt-repository -y ppa:deadsnakes/ppa \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential cmake ninja-build ccache \
      python3.11 python3.11-venv python3.11-dev \
      libboost-program-options-dev libboost-filesystem-dev \
      libboost-graph-dev libboost-system-dev libboost-test-dev \
      libeigen3-dev libflann-dev libfreeimage-dev libmetis-dev \
      libgoogle-glog-dev libgflags-dev libgtest-dev libgmock-dev \
      libsqlite3-dev libglew-dev libcgal-dev \
      libatlas-base-dev libsuitesparse-dev \
 && rm -rf /var/lib/apt/lists/*

# Ceres 2.2.0 (the pairing COLMAP 3.9.x documents) from source.
RUN git clone --depth 1 --branch 2.2.0 https://github.com/ceres-solver/ceres-solver.git /tmp/ceres \
 && cmake -S /tmp/ceres -B /tmp/ceres/build -G Ninja \
      -DCMAKE_BUILD_TYPE=Release \
      -DBUILD_TESTING=OFF -DBUILD_EXAMPLES=OFF \
 && cmake --build /tmp/ceres/build -j"$(nproc)" \
 && cmake --install /tmp/ceres/build \
 && rm -rf /tmp/ceres

# COLMAP with CUDA, headless (no GUI/Qt). Installs `colmap` onto PATH,
# which is exactly what backend/sfm.py looks up via shutil.which.
# COLMAP 3.9.x misses `#include <memory>` in src/colmap/image/line.cc,
# which newer GCC (Ubuntu 22.04) rejects. Harmless no-op once upstream
# carries the include.
RUN git clone --depth 1 --branch "${COLMAP_VERSION}" https://github.com/colmap/colmap.git /tmp/colmap \
 && sed -i 's|^extern "C" {|#include <memory>\nextern "C" {|' /tmp/colmap/src/colmap/image/line.cc \
 && grep -q '#include <memory>' /tmp/colmap/src/colmap/image/line.cc \
 && cmake -S /tmp/colmap -B /tmp/colmap/build -G Ninja \
      -DCMAKE_BUILD_TYPE=Release \
      -DGUI_ENABLED=OFF \
      -DCMAKE_CUDA_ARCHITECTURES="${CUDA_ARCHS}" \
 && cmake --build /tmp/colmap/build -j"$(nproc)" \
 && cmake --install /tmp/colmap/build \
 && rm -rf /tmp/colmap \
 && colmap help >/dev/null

# App venv. Plain `torch` from PyPI ships CUDA wheels, so torch.cuda
# works inside the container once a GPU is passed through.
ENV VIRTUAL_ENV=/opt/venv
ENV PATH="/opt/venv/bin:${PATH}"
WORKDIR /srv/app
COPY backend/requirements.txt ./backend/requirements.txt
RUN python3.11 -m venv /opt/venv \
 && pip install --no-cache-dir --upgrade pip \
 && pip install --no-cache-dir -r backend/requirements.txt

# The app itself (repo root is served as the page by backend/server.py).
COPY . .
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV HF_HOME=/hf-cache \
    MOCK_SAM=1
VOLUME /hf-cache
EXPOSE 8000
ENTRYPOINT ["docker-entrypoint.sh"]
