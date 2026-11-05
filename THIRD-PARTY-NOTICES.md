# 第三方软件声明 / THIRD-PARTY NOTICES

本项目 **Renomio** 以 MIT 许可发布（见 [LICENSE](LICENSE)）。本文件列出随安装包分发、或仅用于构建的第三方组件及其许可证信息。

**数据来源（逐条读取，非记忆推断）**

- `app/src-tauri/Cargo.lock`（Tauri 壳的完整 Rust 依赖图，`ffrn-core` 作为路径依赖在内）
- `app/src-tauri/ffrn-core/Cargo.lock`（核心库独立测试时的依赖图）
- `app/package-lock.json`（lockfileVersion 3，含 workspace `packages/foundation`）
- 许可证字段取自各包元数据；版权行取自各包随附的 `LICENSE` / `LICENCE` / `COPYING` 文件原文

生成日期：2026-11-06。版本号与锁文件严格一致。

## 分组口径

- **运行时依赖**：Rust 沿 `normal` 依赖边、npm 沿根 `dependencies` 及其传递 `dependencies` 可达的第三方包，其代码可能被打进安装包（npm 侧不含 `peerDependencies` / `devDependencies`，故 `typescript`、`@types/*` 归为构建期）。
- **构建期依赖**：只在构建/测试期出现（`build-dependencies`、`devDependencies`，以及仅被它们拉入的包），不会进入安装包。
- 同一个包可能因多许可同时出现在「Apache-2.0」「MIT/BSD/ISC 版权清单」「双许可」三节，这是**有意保留**的：本节按许可证特征检索，不对许可证做取舍。

统计：运行时 215 个（Rust 209、npm 6）；构建期 129 个（Rust 1、npm 128）。

> 说明：`@rename/foundation` 与 `rename-studio` / `ffrn-core` 是本项目自身的包（适用根 `LICENSE` 的 MIT），不计入第三方。

## 1. 运行时依赖 — Rust（209）

| 包 | 版本 | 许可证（原始字段） |
| --- | --- | --- |
| adler2 | 2.0.1 | 0BSD OR MIT OR Apache-2.0 |
| aho-corasick | 1.1.5 | Unlicense OR MIT |
| alloc-no-stdlib | 3.0.0 | BSD-3-Clause |
| alloc-stdlib | 0.3.0 | BSD-3-Clause |
| anyhow | 1.0.104 | MIT OR Apache-2.0 |
| base64 | 0.23.1 | MIT OR Apache-2.0 |
| bit-set | 0.8.0 | Apache-2.0 OR MIT |
| bit-vec | 0.8.0 | Apache-2.0 OR MIT |
| bitflags | 2.13.2 | MIT OR Apache-2.0 |
| block-buffer | 0.10.4 | MIT OR Apache-2.0 |
| brotli | 9.1.1 | BSD-3-Clause AND MIT |
| brotli-decompressor | 6.2.0 | BSD-3-Clause/MIT |
| byteorder | 1.5.0 | Unlicense OR MIT |
| bytes | 1.12.1 | MIT |
| camino | 1.2.6 | MIT OR Apache-2.0 |
| cargo_metadata | 0.19.2 | MIT |
| cargo-platform | 0.1.9 | MIT OR Apache-2.0 |
| cfb | 0.14.0 | MIT |
| cfg-if | 1.0.5 | MIT OR Apache-2.0 |
| cookie | 0.18.2 | MIT OR Apache-2.0 |
| cpufeatures | 0.2.17 | MIT OR Apache-2.0 |
| crc32fast | 1.5.4 | MIT OR Apache-2.0 |
| crossbeam-channel | 0.5.17 | MIT OR Apache-2.0 |
| crossbeam-utils | 0.8.23 | MIT OR Apache-2.0 |
| crypto-common | 0.1.7 | MIT OR Apache-2.0 |
| cssparser | 0.37.0 | MPL-2.0 |
| cssparser-macros | 0.7.1 | MPL-2.0 |
| ctor | 1.0.13 | Apache-2.0 OR MIT |
| darling | 0.24.1 | MIT |
| darling_core | 0.24.1 | MIT |
| darling_macro | 0.24.1 | MIT |
| deranged | 0.5.9 | MIT OR Apache-2.0 |
| derive_more | 2.1.1 | MIT |
| derive_more-impl | 2.1.1 | MIT |
| digest | 0.10.7 | MIT OR Apache-2.0 |
| dirs | 7.0.0 | MIT OR Apache-2.0 |
| dirs-sys | 0.5.0 | MIT OR Apache-2.0 |
| displaydoc | 0.2.7 | MIT OR Apache-2.0 |
| dom_query | 0.28.0 | MIT |
| dpi | 0.1.2 | Apache-2.0 AND MIT |
| dtoa | 1.0.11 | MIT OR Apache-2.0 |
| dtoa-short | 0.3.5 | MPL-2.0 |
| dunce | 1.0.5 | CC0-1.0 OR MIT-0 OR Apache-2.0 |
| dyn-clone | 1.0.20 | MIT OR Apache-2.0 |
| equivalent | 1.0.3 | Apache-2.0 OR MIT |
| erased-serde | 0.4.11 | MIT OR Apache-2.0 |
| fastrand | 2.5.0 | Apache-2.0 OR MIT |
| fdeflate | 0.3.7 | MIT OR Apache-2.0 |
| flate2 | 1.1.10 | MIT OR Apache-2.0 |
| fnv | 1.0.7 | Apache-2.0 / MIT |
| foldhash | 0.2.0 | Zlib |
| form_urlencoded | 1.2.2 | MIT OR Apache-2.0 |
| generic-array | 0.14.7 | MIT |
| getrandom | 0.3.4 | MIT OR Apache-2.0 |
| getrandom | 0.4.3 | MIT OR Apache-2.0 |
| glob | 0.3.4 | MIT OR Apache-2.0 |
| hashbrown | 0.12.3 | MIT OR Apache-2.0 |
| hashbrown | 0.17.1 | MIT OR Apache-2.0 |
| heck | 0.5.0 | MIT OR Apache-2.0 |
| html5ever | 0.39.0 | MIT OR Apache-2.0 |
| http | 1.5.0 | MIT OR Apache-2.0 |
| ico | 0.6.0 | MIT |
| icu_collections | 2.4.0 | Unicode-3.0 |
| icu_locale_core | 2.4.0 | Unicode-3.0 |
| icu_normalizer | 2.4.0 | Unicode-3.0 |
| icu_normalizer_data | 2.4.0 | Unicode-3.0 |
| icu_properties | 2.4.0 | Unicode-3.0 |
| icu_properties_data | 2.4.0 | Unicode-3.0 |
| icu_provider | 2.4.0 | Unicode-3.0 |
| ident_case | 1.0.1 | MIT/Apache-2.0 |
| idna | 1.1.0 | MIT OR Apache-2.0 |
| idna_adapter | 1.2.2 | Apache-2.0 OR MIT |
| indexmap | 1.9.3 | Apache-2.0 OR MIT |
| indexmap | 2.14.2 | Apache-2.0 OR MIT |
| infer | 0.22.0 | MIT |
| itoa | 1.0.18 | MIT OR Apache-2.0 |
| json-patch | 4.2.0 | MIT/Apache-2.0 |
| jsonptr | 0.7.1 | MIT OR Apache-2.0 |
| keyboard-types | 0.8.3 | MIT OR Apache-2.0 |
| libc | 0.2.191 | MIT OR Apache-2.0 |
| litemap | 0.8.3 | Unicode-3.0 |
| lock_api | 0.4.14 | MIT OR Apache-2.0 |
| log | 0.4.35 | MIT OR Apache-2.0 |
| markup5ever | 0.39.0 | MIT OR Apache-2.0 |
| memchr | 2.8.3 | Unlicense OR MIT |
| mime | 0.3.17 | MIT OR Apache-2.0 |
| miniz_oxide | 0.8.9 | MIT OR Zlib OR Apache-2.0 |
| miniz_oxide | 0.9.1 | MIT OR Zlib OR Apache-2.0 |
| muda | 0.20.0 | Apache-2.0 OR MIT |
| new_debug_unreachable | 1.0.6 | MIT |
| num-conv | 0.2.2 | MIT OR Apache-2.0 |
| once_cell | 1.21.4 | MIT OR Apache-2.0 |
| option-ext | 0.2.0 | MPL-2.0 |
| parking_lot | 0.12.5 | MIT OR Apache-2.0 |
| parking_lot_core | 0.9.12 | MIT OR Apache-2.0 |
| percent-encoding | 2.3.2 | MIT OR Apache-2.0 |
| phf | 0.13.1 | MIT |
| phf_generator | 0.13.1 | MIT |
| phf_macros | 0.13.1 | MIT |
| phf_shared | 0.13.1 | MIT |
| pin-project-lite | 0.2.17 | Apache-2.0 OR MIT |
| plist | 1.10.3 | MIT |
| png | 0.18.1 | MIT OR Apache-2.0 |
| potential_utf | 0.1.6 | Unicode-3.0 |
| powerfmt | 0.2.1 | MIT OR Apache-2.0 |
| precomputed-hash | 0.1.1 | MIT |
| proc-macro2 | 1.0.107 | MIT OR Apache-2.0 |
| quick-xml | 0.42.0 | MIT |
| quote | 1.0.47 | MIT OR Apache-2.0 |
| raw-window-handle | 0.6.2 | MIT OR Apache-2.0 OR Zlib |
| regex | 1.13.1 | MIT OR Apache-2.0 |
| regex-automata | 0.4.18 | MIT OR Apache-2.0 |
| regex-syntax | 0.8.11 | MIT OR Apache-2.0 |
| rfd | 0.17.2 | MIT |
| rustc-hash | 2.1.3 | Apache-2.0 OR MIT |
| same-file | 1.0.6 | Unlicense/MIT |
| schemars | 0.8.22 | MIT |
| schemars_derive | 0.8.22 | MIT |
| scopeguard | 1.2.0 | MIT OR Apache-2.0 |
| selectors | 0.38.0 | MPL-2.0 |
| semver | 1.0.28 | MIT OR Apache-2.0 |
| serde | 1.0.229 | MIT OR Apache-2.0 |
| serde_core | 1.0.229 | MIT OR Apache-2.0 |
| serde_derive | 1.0.229 | MIT OR Apache-2.0 |
| serde_derive_internals | 0.29.1 | MIT OR Apache-2.0 |
| serde_json | 1.0.154 | MIT OR Apache-2.0 |
| serde_repr | 0.1.21 | MIT OR Apache-2.0 |
| serde_spanned | 1.1.2 | MIT OR Apache-2.0 |
| serde_with | 3.24.0 | MIT OR Apache-2.0 |
| serde_with_macros | 3.24.0 | MIT OR Apache-2.0 |
| serde-untagged | 0.1.9 | MIT OR Apache-2.0 |
| serialize-to-javascript | 0.1.2 | MIT OR Apache-2.0 |
| serialize-to-javascript-impl | 0.1.2 | MIT OR Apache-2.0 |
| servo_arc | 0.4.3 | MIT OR Apache-2.0 |
| sha2 | 0.10.9 | MIT OR Apache-2.0 |
| simd-adler32 | 0.3.10 | MIT |
| siphasher | 1.0.4 | MIT OR Apache-2.0 |
| smallvec | 1.16.4 | MIT OR Apache-2.0 |
| softbuffer | 0.4.8 | MIT OR Apache-2.0 |
| stable_deref_trait | 1.2.1 | MIT OR Apache-2.0 |
| string_cache | 0.9.0 | MIT OR Apache-2.0 |
| strsim | 0.11.1 | MIT |
| syn | 2.0.119 | MIT OR Apache-2.0 |
| syn | 3.0.9 | MIT OR Apache-2.0 |
| synstructure | 0.14.0 | MIT |
| tao | 0.37.2 | Apache-2.0 |
| tauri | 2.12.5 | Apache-2.0 OR MIT |
| tauri-codegen | 2.7.4 | Apache-2.0 OR MIT |
| tauri-macros | 2.7.4 | Apache-2.0 OR MIT |
| tauri-plugin-dialog | 2.8.4 | Apache-2.0 OR MIT |
| tauri-plugin-fs | 2.7.1 | Apache-2.0 OR MIT |
| tauri-runtime | 2.12.2 | Apache-2.0 OR MIT |
| tauri-runtime-wry | 2.12.3 | Apache-2.0 OR MIT |
| tauri-utils | 2.10.2 | Apache-2.0 OR MIT |
| tendril | 0.5.1 | MIT OR Apache-2.0 |
| thiserror | 2.0.21 | MIT OR Apache-2.0 |
| thiserror-impl | 2.0.21 | MIT OR Apache-2.0 |
| time | 0.3.55 | MIT OR Apache-2.0 |
| time-core | 0.1.9 | MIT OR Apache-2.0 |
| time-macros | 0.2.32 | MIT OR Apache-2.0 |
| tinystr | 0.8.5 | Unicode-3.0 |
| tokio | 1.54.1 | MIT |
| toml | 1.2.0+spec-1.1.0 | MIT OR Apache-2.0 |
| toml_datetime | 1.1.2+spec-1.1.0 | MIT OR Apache-2.0 |
| toml_parser | 1.1.5+spec-1.1.0 | MIT OR Apache-2.0 |
| toml_writer | 1.2.0+spec-1.1.0 | MIT OR Apache-2.0 |
| tracing | 0.1.44 | MIT |
| tracing-core | 0.1.36 | MIT |
| typeid | 1.0.3 | MIT OR Apache-2.0 |
| typenum | 1.20.1 | MIT OR Apache-2.0 |
| unicode-ident | 1.0.27 | (MIT OR Apache-2.0) AND Unicode-3.0 |
| unicode-segmentation | 1.13.3 | MIT OR Apache-2.0 |
| url | 2.5.8 | MIT OR Apache-2.0 |
| urlpattern | 0.6.0 | MIT |
| utf_types | 1.0.0 | Apache-2.0 OR MIT |
| utf8_iter | 1.1.0 | Apache-2.0 OR MIT |
| uuid | 1.29.0 | Apache-2.0 OR MIT |
| walkdir | 2.5.0 | Unlicense/MIT |
| web_atoms | 0.2.6 | MIT OR Apache-2.0 |
| web-time | 1.1.0 | MIT OR Apache-2.0 |
| webview2-com | 0.39.1 | MIT |
| webview2-com-macros | 0.8.1 | MIT |
| webview2-com-sys | 0.39.1 | MIT |
| winapi-util | 0.1.11 | Unlicense OR MIT |
| window-vibrancy | 0.8.1 | Apache-2.0 OR MIT |
| windows | 0.62.2 | MIT OR Apache-2.0 |
| windows-collections | 0.3.2 | MIT OR Apache-2.0 |
| windows-core | 0.62.2 | MIT OR Apache-2.0 |
| windows-future | 0.3.2 | MIT OR Apache-2.0 |
| windows-implement | 0.60.2 | MIT OR Apache-2.0 |
| windows-interface | 0.59.3 | MIT OR Apache-2.0 |
| windows-link | 0.2.1 | MIT OR Apache-2.0 |
| windows-numerics | 0.3.1 | MIT OR Apache-2.0 |
| windows-result | 0.4.1 | MIT OR Apache-2.0 |
| windows-strings | 0.5.1 | MIT OR Apache-2.0 |
| windows-sys | 0.61.2 | MIT OR Apache-2.0 |
| windows-threading | 0.2.1 | MIT OR Apache-2.0 |
| windows-version | 0.1.7 | MIT OR Apache-2.0 |
| winnow | 1.0.4 | MIT |
| writeable | 0.6.4 | Unicode-3.0 |
| wry | 0.57.1 | Apache-2.0 OR MIT |
| yoke | 0.8.4 | Unicode-3.0 |
| yoke-derive | 0.8.4 | Unicode-3.0 |
| zerofrom | 0.1.8 | Unicode-3.0 |
| zerofrom-derive | 0.1.8 | Unicode-3.0 |
| zerotrie | 0.2.5 | Unicode-3.0 |
| zerovec | 0.11.9 | Unicode-3.0 |
| zerovec-derive | 0.11.7 | Unicode-3.0 |
| zmij | 1.0.23 | MIT |

## 2. 运行时依赖 — npm（6）

| 包 | 版本 | 许可证（原始字段） |
| --- | --- | --- |
| @tauri-apps/api | 2.12.4 | Apache-2.0 OR MIT |
| @tauri-apps/plugin-dialog | 2.8.4 | MIT OR Apache-2.0 |
| react | 19.3.1 | MIT |
| react-dom | 19.3.1 | MIT |
| scheduler | 0.28.0 | MIT |
| zustand | 5.0.16 | MIT |

## 3. 构建期依赖 — Rust（1）

| 包 | 版本 | 许可证（原始字段） |
| --- | --- | --- |
| tauri-build | 2.7.4 | Apache-2.0 OR MIT |

## 4. 构建期依赖 — npm（128）

| 包 | 版本 | 许可证（原始字段） |
| --- | --- | --- |
| @babel/code-frame | 7.29.7 | MIT |
| @babel/compat-data | 7.29.7 | MIT |
| @babel/core | 7.29.7 | MIT |
| @babel/generator | 7.29.12 | MIT |
| @babel/helper-compilation-targets | 7.29.7 | MIT |
| @babel/helper-globals | 7.29.7 | MIT |
| @babel/helper-module-imports | 7.29.7 | MIT |
| @babel/helper-module-transforms | 7.29.7 | MIT |
| @babel/helper-plugin-utils | 7.29.7 | MIT |
| @babel/helper-string-parser | 7.29.11 | MIT |
| @babel/helper-validator-identifier | 7.29.7 | MIT |
| @babel/helper-validator-option | 7.29.7 | MIT |
| @babel/helpers | 7.29.10 | MIT |
| @babel/parser | 7.29.12 | MIT |
| @babel/plugin-transform-react-jsx-self | 7.29.7 | MIT |
| @babel/plugin-transform-react-jsx-source | 7.29.7 | MIT |
| @babel/template | 7.29.7 | MIT |
| @babel/traverse | 7.29.12 | MIT |
| @babel/types | 7.29.11 | MIT |
| @esbuild/aix-ppc64 | 0.28.2 | MIT |
| @esbuild/android-arm | 0.28.2 | MIT |
| @esbuild/android-arm64 | 0.28.2 | MIT |
| @esbuild/android-x64 | 0.28.2 | MIT |
| @esbuild/darwin-arm64 | 0.28.2 | MIT |
| @esbuild/darwin-x64 | 0.28.2 | MIT |
| @esbuild/freebsd-arm64 | 0.28.2 | MIT |
| @esbuild/freebsd-x64 | 0.28.2 | MIT |
| @esbuild/linux-arm | 0.28.2 | MIT |
| @esbuild/linux-arm64 | 0.28.2 | MIT |
| @esbuild/linux-ia32 | 0.28.2 | MIT |
| @esbuild/linux-loong64 | 0.28.2 | MIT |
| @esbuild/linux-mips64el | 0.28.2 | MIT |
| @esbuild/linux-ppc64 | 0.28.2 | MIT |
| @esbuild/linux-riscv64 | 0.28.2 | MIT |
| @esbuild/linux-s390x | 0.28.2 | MIT |
| @esbuild/linux-x64 | 0.28.2 | MIT |
| @esbuild/netbsd-arm64 | 0.28.2 | MIT |
| @esbuild/netbsd-x64 | 0.28.2 | MIT |
| @esbuild/openbsd-arm64 | 0.28.2 | MIT |
| @esbuild/openbsd-x64 | 0.28.2 | MIT |
| @esbuild/openharmony-arm64 | 0.28.2 | MIT |
| @esbuild/sunos-x64 | 0.28.2 | MIT |
| @esbuild/win32-arm64 | 0.28.2 | MIT |
| @esbuild/win32-ia32 | 0.28.2 | MIT |
| @esbuild/win32-x64 | 0.28.2 | MIT |
| @jridgewell/gen-mapping | 0.3.13 | MIT |
| @jridgewell/remapping | 2.3.5 | MIT |
| @jridgewell/resolve-uri | 3.1.2 | MIT |
| @jridgewell/sourcemap-codec | 1.6.0 | MIT |
| @jridgewell/trace-mapping | 0.3.31 | MIT |
| @rolldown/pluginutils | 1.0.0-rc.3 | MIT |
| @rollup/rollup-android-arm-eabi | 4.67.5 | MIT |
| @rollup/rollup-android-arm64 | 4.67.5 | MIT |
| @rollup/rollup-android-x64 | 4.67.5 | MIT |
| @rollup/rollup-darwin-arm64 | 4.67.5 | MIT |
| @rollup/rollup-darwin-x64 | 4.67.5 | MIT |
| @rollup/rollup-freebsd-arm64 | 4.67.5 | MIT |
| @rollup/rollup-freebsd-x64 | 4.67.5 | MIT |
| @rollup/rollup-linux-arm-gnueabihf | 4.67.5 | MIT |
| @rollup/rollup-linux-arm-musleabihf | 4.67.5 | MIT |
| @rollup/rollup-linux-arm64-gnu | 4.67.5 | MIT |
| @rollup/rollup-linux-arm64-musl | 4.67.5 | MIT |
| @rollup/rollup-linux-loong64-gnu | 4.67.5 | MIT |
| @rollup/rollup-linux-loong64-musl | 4.67.5 | MIT |
| @rollup/rollup-linux-ppc64-gnu | 4.67.5 | MIT |
| @rollup/rollup-linux-ppc64-musl | 4.67.5 | MIT |
| @rollup/rollup-linux-riscv64-gnu | 4.67.5 | MIT |
| @rollup/rollup-linux-riscv64-musl | 4.67.5 | MIT |
| @rollup/rollup-linux-s390x-gnu | 4.67.5 | MIT |
| @rollup/rollup-linux-x64-gnu | 4.67.5 | MIT |
| @rollup/rollup-linux-x64-musl | 4.67.5 | MIT |
| @rollup/rollup-openbsd-x64 | 4.67.5 | MIT |
| @rollup/rollup-openharmony-arm64 | 4.67.5 | MIT |
| @rollup/rollup-win32-arm64-msvc | 4.67.5 | MIT |
| @rollup/rollup-win32-ia32-msvc | 4.67.5 | MIT |
| @rollup/rollup-win32-x64-gnu | 4.67.5 | MIT |
| @rollup/rollup-win32-x64-msvc | 4.67.5 | MIT |
| @tauri-apps/cli | 2.12.4 | Apache-2.0 OR MIT |
| @tauri-apps/cli-darwin-arm64 | 2.12.4 | Apache-2.0 OR MIT |
| @tauri-apps/cli-darwin-x64 | 2.12.4 | Apache-2.0 OR MIT |
| @tauri-apps/cli-linux-arm-gnueabihf | 2.12.4 | Apache-2.0 OR MIT |
| @tauri-apps/cli-linux-arm64-gnu | 2.12.4 | Apache-2.0 OR MIT |
| @tauri-apps/cli-linux-arm64-musl | 2.12.4 | Apache-2.0 OR MIT |
| @tauri-apps/cli-linux-riscv64-gnu | 2.12.4 | Apache-2.0 OR MIT |
| @tauri-apps/cli-linux-x64-gnu | 2.12.4 | Apache-2.0 OR MIT |
| @tauri-apps/cli-linux-x64-musl | 2.12.4 | Apache-2.0 OR MIT |
| @tauri-apps/cli-win32-arm64-msvc | 2.12.4 | Apache-2.0 OR MIT |
| @tauri-apps/cli-win32-ia32-msvc | 2.12.4 | Apache-2.0 OR MIT |
| @tauri-apps/cli-win32-x64-msvc | 2.12.4 | Apache-2.0 OR MIT |
| @types/babel__core | 7.20.5 | MIT |
| @types/babel__generator | 7.27.0 | MIT |
| @types/babel__template | 7.4.4 | MIT |
| @types/babel__traverse | 7.28.0 | MIT |
| @types/estree | 1.0.10 | MIT |
| @types/react | 19.3.0 | MIT |
| @types/react-dom | 19.3.0 | MIT |
| @vitejs/plugin-react | 5.2.0 | MIT |
| baseline-browser-mapping | 2.11.35 | Apache-2.0 |
| browserslist | 4.29.5 | MIT |
| caniuse-lite | 1.0.30001820 | CC-BY-4.0 |
| convert-source-map | 2.0.0 | MIT |
| csstype | 3.2.3 | MIT |
| debug | 4.4.3 | MIT |
| electron-to-chromium | 1.5.476 | ISC |
| esbuild | 0.28.2 | MIT |
| escalade | 3.2.0 | MIT |
| fdir | 6.5.0 | MIT |
| fsevents | 2.3.3 | MIT |
| gensync | 1.0.0-beta.2 | MIT |
| js-tokens | 4.0.0 | MIT |
| jsesc | 3.1.0 | MIT |
| json5 | 2.2.3 | MIT |
| lru-cache | 5.1.1 | ISC |
| ms | 2.1.3 | MIT |
| nanoid | 3.3.20 | MIT |
| node-releases | 2.0.63 | MIT |
| picocolors | 1.1.1 | ISC |
| picomatch | 4.0.7 | MIT |
| postcss | 8.5.32 | MIT |
| react-refresh | 0.18.0 | MIT |
| rollup | 4.67.5 | MIT |
| semver | 6.3.2 | ISC |
| source-map-js | 1.2.2 | BSD-3-Clause |
| tinyglobby | 0.2.17 | MIT |
| typescript | 5.9.3 | Apache-2.0 |
| update-browserslist-db | 1.3.4 | MIT |
| vite | 7.3.7 | MIT |
| yallist | 3.1.1 | ISC |

## 5. Apache-2.0 依赖与 NOTICE 保留要求（157）

Apache-2.0 第 4(d) 条要求：若被分发的作品（或其衍生作品）中包含原作者提供的 `NOTICE` 文本文件，则必须在分发中保留该 NOTICE 的内容（可放在随附的声明文件中，或以可读形式随二进制分发）。

本轮扫描结果：这 157 个含 Apache-2.0 的包中，随包附带独立 `NOTICE` 文件的有 **0 个**（即无需额外保留的 NOTICE 文件，仍保留本节的署名与许可证信息）。

| 包 | 版本 | 许可证 | 分组 |
| --- | --- | --- | --- |
| @tauri-apps/api | 2.12.4 | Apache-2.0 OR MIT | 运行时 |
| @tauri-apps/cli | 2.12.4 | Apache-2.0 OR MIT | 构建期 |
| @tauri-apps/cli-darwin-arm64 | 2.12.4 | Apache-2.0 OR MIT | 构建期 |
| @tauri-apps/cli-darwin-x64 | 2.12.4 | Apache-2.0 OR MIT | 构建期 |
| @tauri-apps/cli-linux-arm-gnueabihf | 2.12.4 | Apache-2.0 OR MIT | 构建期 |
| @tauri-apps/cli-linux-arm64-gnu | 2.12.4 | Apache-2.0 OR MIT | 构建期 |
| @tauri-apps/cli-linux-arm64-musl | 2.12.4 | Apache-2.0 OR MIT | 构建期 |
| @tauri-apps/cli-linux-riscv64-gnu | 2.12.4 | Apache-2.0 OR MIT | 构建期 |
| @tauri-apps/cli-linux-x64-gnu | 2.12.4 | Apache-2.0 OR MIT | 构建期 |
| @tauri-apps/cli-linux-x64-musl | 2.12.4 | Apache-2.0 OR MIT | 构建期 |
| @tauri-apps/cli-win32-arm64-msvc | 2.12.4 | Apache-2.0 OR MIT | 构建期 |
| @tauri-apps/cli-win32-ia32-msvc | 2.12.4 | Apache-2.0 OR MIT | 构建期 |
| @tauri-apps/cli-win32-x64-msvc | 2.12.4 | Apache-2.0 OR MIT | 构建期 |
| @tauri-apps/plugin-dialog | 2.8.4 | MIT OR Apache-2.0 | 运行时 |
| adler2 | 2.0.1 | 0BSD OR MIT OR Apache-2.0 | 运行时 |
| anyhow | 1.0.104 | MIT OR Apache-2.0 | 运行时 |
| base64 | 0.23.1 | MIT OR Apache-2.0 | 运行时 |
| baseline-browser-mapping | 2.11.35 | Apache-2.0 | 构建期 |
| bit-set | 0.8.0 | Apache-2.0 OR MIT | 运行时 |
| bit-vec | 0.8.0 | Apache-2.0 OR MIT | 运行时 |
| bitflags | 2.13.2 | MIT OR Apache-2.0 | 运行时 |
| block-buffer | 0.10.4 | MIT OR Apache-2.0 | 运行时 |
| camino | 1.2.6 | MIT OR Apache-2.0 | 运行时 |
| cargo-platform | 0.1.9 | MIT OR Apache-2.0 | 运行时 |
| cfg-if | 1.0.5 | MIT OR Apache-2.0 | 运行时 |
| cookie | 0.18.2 | MIT OR Apache-2.0 | 运行时 |
| cpufeatures | 0.2.17 | MIT OR Apache-2.0 | 运行时 |
| crc32fast | 1.5.4 | MIT OR Apache-2.0 | 运行时 |
| crossbeam-channel | 0.5.17 | MIT OR Apache-2.0 | 运行时 |
| crossbeam-utils | 0.8.23 | MIT OR Apache-2.0 | 运行时 |
| crypto-common | 0.1.7 | MIT OR Apache-2.0 | 运行时 |
| ctor | 1.0.13 | Apache-2.0 OR MIT | 运行时 |
| deranged | 0.5.9 | MIT OR Apache-2.0 | 运行时 |
| digest | 0.10.7 | MIT OR Apache-2.0 | 运行时 |
| dirs | 7.0.0 | MIT OR Apache-2.0 | 运行时 |
| dirs-sys | 0.5.0 | MIT OR Apache-2.0 | 运行时 |
| displaydoc | 0.2.7 | MIT OR Apache-2.0 | 运行时 |
| dpi | 0.1.2 | Apache-2.0 AND MIT | 运行时 |
| dtoa | 1.0.11 | MIT OR Apache-2.0 | 运行时 |
| dunce | 1.0.5 | CC0-1.0 OR MIT-0 OR Apache-2.0 | 运行时 |
| dyn-clone | 1.0.20 | MIT OR Apache-2.0 | 运行时 |
| equivalent | 1.0.3 | Apache-2.0 OR MIT | 运行时 |
| erased-serde | 0.4.11 | MIT OR Apache-2.0 | 运行时 |
| fastrand | 2.5.0 | Apache-2.0 OR MIT | 运行时 |
| fdeflate | 0.3.7 | MIT OR Apache-2.0 | 运行时 |
| flate2 | 1.1.10 | MIT OR Apache-2.0 | 运行时 |
| fnv | 1.0.7 | Apache-2.0 / MIT | 运行时 |
| form_urlencoded | 1.2.2 | MIT OR Apache-2.0 | 运行时 |
| getrandom | 0.3.4 | MIT OR Apache-2.0 | 运行时 |
| getrandom | 0.4.3 | MIT OR Apache-2.0 | 运行时 |
| glob | 0.3.4 | MIT OR Apache-2.0 | 运行时 |
| hashbrown | 0.12.3 | MIT OR Apache-2.0 | 运行时 |
| hashbrown | 0.17.1 | MIT OR Apache-2.0 | 运行时 |
| heck | 0.5.0 | MIT OR Apache-2.0 | 运行时 |
| html5ever | 0.39.0 | MIT OR Apache-2.0 | 运行时 |
| http | 1.5.0 | MIT OR Apache-2.0 | 运行时 |
| ident_case | 1.0.1 | MIT/Apache-2.0 | 运行时 |
| idna | 1.1.0 | MIT OR Apache-2.0 | 运行时 |
| idna_adapter | 1.2.2 | Apache-2.0 OR MIT | 运行时 |
| indexmap | 1.9.3 | Apache-2.0 OR MIT | 运行时 |
| indexmap | 2.14.2 | Apache-2.0 OR MIT | 运行时 |
| itoa | 1.0.18 | MIT OR Apache-2.0 | 运行时 |
| json-patch | 4.2.0 | MIT/Apache-2.0 | 运行时 |
| jsonptr | 0.7.1 | MIT OR Apache-2.0 | 运行时 |
| keyboard-types | 0.8.3 | MIT OR Apache-2.0 | 运行时 |
| libc | 0.2.191 | MIT OR Apache-2.0 | 运行时 |
| lock_api | 0.4.14 | MIT OR Apache-2.0 | 运行时 |
| log | 0.4.35 | MIT OR Apache-2.0 | 运行时 |
| markup5ever | 0.39.0 | MIT OR Apache-2.0 | 运行时 |
| mime | 0.3.17 | MIT OR Apache-2.0 | 运行时 |
| miniz_oxide | 0.8.9 | MIT OR Zlib OR Apache-2.0 | 运行时 |
| miniz_oxide | 0.9.1 | MIT OR Zlib OR Apache-2.0 | 运行时 |
| muda | 0.20.0 | Apache-2.0 OR MIT | 运行时 |
| num-conv | 0.2.2 | MIT OR Apache-2.0 | 运行时 |
| once_cell | 1.21.4 | MIT OR Apache-2.0 | 运行时 |
| parking_lot | 0.12.5 | MIT OR Apache-2.0 | 运行时 |
| parking_lot_core | 0.9.12 | MIT OR Apache-2.0 | 运行时 |
| percent-encoding | 2.3.2 | MIT OR Apache-2.0 | 运行时 |
| pin-project-lite | 0.2.17 | Apache-2.0 OR MIT | 运行时 |
| png | 0.18.1 | MIT OR Apache-2.0 | 运行时 |
| powerfmt | 0.2.1 | MIT OR Apache-2.0 | 运行时 |
| proc-macro2 | 1.0.107 | MIT OR Apache-2.0 | 运行时 |
| quote | 1.0.47 | MIT OR Apache-2.0 | 运行时 |
| raw-window-handle | 0.6.2 | MIT OR Apache-2.0 OR Zlib | 运行时 |
| regex | 1.13.1 | MIT OR Apache-2.0 | 运行时 |
| regex-automata | 0.4.18 | MIT OR Apache-2.0 | 运行时 |
| regex-syntax | 0.8.11 | MIT OR Apache-2.0 | 运行时 |
| rustc-hash | 2.1.3 | Apache-2.0 OR MIT | 运行时 |
| scopeguard | 1.2.0 | MIT OR Apache-2.0 | 运行时 |
| semver | 1.0.28 | MIT OR Apache-2.0 | 运行时 |
| serde | 1.0.229 | MIT OR Apache-2.0 | 运行时 |
| serde_core | 1.0.229 | MIT OR Apache-2.0 | 运行时 |
| serde_derive | 1.0.229 | MIT OR Apache-2.0 | 运行时 |
| serde_derive_internals | 0.29.1 | MIT OR Apache-2.0 | 运行时 |
| serde_json | 1.0.154 | MIT OR Apache-2.0 | 运行时 |
| serde_repr | 0.1.21 | MIT OR Apache-2.0 | 运行时 |
| serde_spanned | 1.1.2 | MIT OR Apache-2.0 | 运行时 |
| serde_with | 3.24.0 | MIT OR Apache-2.0 | 运行时 |
| serde_with_macros | 3.24.0 | MIT OR Apache-2.0 | 运行时 |
| serde-untagged | 0.1.9 | MIT OR Apache-2.0 | 运行时 |
| serialize-to-javascript | 0.1.2 | MIT OR Apache-2.0 | 运行时 |
| serialize-to-javascript-impl | 0.1.2 | MIT OR Apache-2.0 | 运行时 |
| servo_arc | 0.4.3 | MIT OR Apache-2.0 | 运行时 |
| sha2 | 0.10.9 | MIT OR Apache-2.0 | 运行时 |
| siphasher | 1.0.4 | MIT OR Apache-2.0 | 运行时 |
| smallvec | 1.16.4 | MIT OR Apache-2.0 | 运行时 |
| softbuffer | 0.4.8 | MIT OR Apache-2.0 | 运行时 |
| stable_deref_trait | 1.2.1 | MIT OR Apache-2.0 | 运行时 |
| string_cache | 0.9.0 | MIT OR Apache-2.0 | 运行时 |
| syn | 2.0.119 | MIT OR Apache-2.0 | 运行时 |
| syn | 3.0.9 | MIT OR Apache-2.0 | 运行时 |
| tao | 0.37.2 | Apache-2.0 | 运行时 |
| tauri | 2.12.5 | Apache-2.0 OR MIT | 运行时 |
| tauri-build | 2.7.4 | Apache-2.0 OR MIT | 构建期 |
| tauri-codegen | 2.7.4 | Apache-2.0 OR MIT | 运行时 |
| tauri-macros | 2.7.4 | Apache-2.0 OR MIT | 运行时 |
| tauri-plugin-dialog | 2.8.4 | Apache-2.0 OR MIT | 运行时 |
| tauri-plugin-fs | 2.7.1 | Apache-2.0 OR MIT | 运行时 |
| tauri-runtime | 2.12.2 | Apache-2.0 OR MIT | 运行时 |
| tauri-runtime-wry | 2.12.3 | Apache-2.0 OR MIT | 运行时 |
| tauri-utils | 2.10.2 | Apache-2.0 OR MIT | 运行时 |
| tendril | 0.5.1 | MIT OR Apache-2.0 | 运行时 |
| thiserror | 2.0.21 | MIT OR Apache-2.0 | 运行时 |
| thiserror-impl | 2.0.21 | MIT OR Apache-2.0 | 运行时 |
| time | 0.3.55 | MIT OR Apache-2.0 | 运行时 |
| time-core | 0.1.9 | MIT OR Apache-2.0 | 运行时 |
| time-macros | 0.2.32 | MIT OR Apache-2.0 | 运行时 |
| toml | 1.2.0+spec-1.1.0 | MIT OR Apache-2.0 | 运行时 |
| toml_datetime | 1.1.2+spec-1.1.0 | MIT OR Apache-2.0 | 运行时 |
| toml_parser | 1.1.5+spec-1.1.0 | MIT OR Apache-2.0 | 运行时 |
| toml_writer | 1.2.0+spec-1.1.0 | MIT OR Apache-2.0 | 运行时 |
| typeid | 1.0.3 | MIT OR Apache-2.0 | 运行时 |
| typenum | 1.20.1 | MIT OR Apache-2.0 | 运行时 |
| typescript | 5.9.3 | Apache-2.0 | 构建期 |
| unicode-ident | 1.0.27 | (MIT OR Apache-2.0) AND Unicode-3.0 | 运行时 |
| unicode-segmentation | 1.13.3 | MIT OR Apache-2.0 | 运行时 |
| url | 2.5.8 | MIT OR Apache-2.0 | 运行时 |
| utf_types | 1.0.0 | Apache-2.0 OR MIT | 运行时 |
| utf8_iter | 1.1.0 | Apache-2.0 OR MIT | 运行时 |
| uuid | 1.29.0 | Apache-2.0 OR MIT | 运行时 |
| web_atoms | 0.2.6 | MIT OR Apache-2.0 | 运行时 |
| web-time | 1.1.0 | MIT OR Apache-2.0 | 运行时 |
| window-vibrancy | 0.8.1 | Apache-2.0 OR MIT | 运行时 |
| windows | 0.62.2 | MIT OR Apache-2.0 | 运行时 |
| windows-collections | 0.3.2 | MIT OR Apache-2.0 | 运行时 |
| windows-core | 0.62.2 | MIT OR Apache-2.0 | 运行时 |
| windows-future | 0.3.2 | MIT OR Apache-2.0 | 运行时 |
| windows-implement | 0.60.2 | MIT OR Apache-2.0 | 运行时 |
| windows-interface | 0.59.3 | MIT OR Apache-2.0 | 运行时 |
| windows-link | 0.2.1 | MIT OR Apache-2.0 | 运行时 |
| windows-numerics | 0.3.1 | MIT OR Apache-2.0 | 运行时 |
| windows-result | 0.4.1 | MIT OR Apache-2.0 | 运行时 |
| windows-strings | 0.5.1 | MIT OR Apache-2.0 | 运行时 |
| windows-sys | 0.61.2 | MIT OR Apache-2.0 | 运行时 |
| windows-threading | 0.2.1 | MIT OR Apache-2.0 | 运行时 |
| windows-version | 0.1.7 | MIT OR Apache-2.0 | 运行时 |
| wry | 0.57.1 | Apache-2.0 OR MIT | 运行时 |

## 6. MIT / BSD / ISC 合并版权声明（316）

以下包采用 MIT / BSD / ISC 类许可，按要求保留其版权声明。版权行为各包 `LICENSE` 文件原文（每包最多取前 3 行）。

| 包 | 版本 | 版权行原文 |
| --- | --- | --- |
| @babel/code-frame | 7.29.7 | Copyright (c) 2014-present Sebastian McKenzie and other contributors / The above copyright notice and this permission notice shall be / NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE |
| @babel/compat-data | 7.29.7 | Copyright (c) 2014-present Sebastian McKenzie and other contributors / The above copyright notice and this permission notice shall be / NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE |
| @babel/core | 7.29.7 | Copyright (c) 2014-present Sebastian McKenzie and other contributors / The above copyright notice and this permission notice shall be / NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE |
| @babel/generator | 7.29.12 | Copyright (c) 2014-present Sebastian McKenzie and other contributors / The above copyright notice and this permission notice shall be / NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE |
| @babel/helper-compilation-targets | 7.29.7 | Copyright (c) 2014-present Sebastian McKenzie and other contributors / The above copyright notice and this permission notice shall be / NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE |
| @babel/helper-globals | 7.29.7 | Copyright (c) 2014-present Sebastian McKenzie and other contributors / The above copyright notice and this permission notice shall be / NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE |
| @babel/helper-module-imports | 7.29.7 | Copyright (c) 2014-present Sebastian McKenzie and other contributors / The above copyright notice and this permission notice shall be / NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE |
| @babel/helper-module-transforms | 7.29.7 | Copyright (c) 2014-present Sebastian McKenzie and other contributors / The above copyright notice and this permission notice shall be / NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE |
| @babel/helper-plugin-utils | 7.29.7 | Copyright (c) 2014-present Sebastian McKenzie and other contributors / The above copyright notice and this permission notice shall be / NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE |
| @babel/helper-string-parser | 7.29.11 | Copyright (c) 2014-present Sebastian McKenzie and other contributors / The above copyright notice and this permission notice shall be / NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE |
| @babel/helper-validator-identifier | 7.29.7 | Copyright (c) 2014-present Sebastian McKenzie and other contributors / The above copyright notice and this permission notice shall be / NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE |
| @babel/helper-validator-option | 7.29.7 | Copyright (c) 2014-present Sebastian McKenzie and other contributors / The above copyright notice and this permission notice shall be / NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE |
| @babel/helpers | 7.29.10 | Copyright (c) 2014-present Sebastian McKenzie and other contributors / Copyright (c) 2014-present, Facebook, Inc. (ONLY ./src/helpers/regenerator* files) / The above copyright notice and this permission notice shall be |
| @babel/parser | 7.29.12 | Copyright (C) 2012-2014 by various contributors (see AUTHORS) / The above copyright notice and this permission notice shall be included in / AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER |
| @babel/plugin-transform-react-jsx-self | 7.29.7 | Copyright (c) 2014-present Sebastian McKenzie and other contributors / The above copyright notice and this permission notice shall be / NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE |
| @babel/plugin-transform-react-jsx-source | 7.29.7 | Copyright (c) 2014-present Sebastian McKenzie and other contributors / The above copyright notice and this permission notice shall be / NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE |
| @babel/template | 7.29.7 | Copyright (c) 2014-present Sebastian McKenzie and other contributors / The above copyright notice and this permission notice shall be / NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE |
| @babel/traverse | 7.29.12 | Copyright (c) 2014-present Sebastian McKenzie and other contributors / The above copyright notice and this permission notice shall be / NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE |
| @babel/types | 7.29.11 | Copyright (c) 2014-present Sebastian McKenzie and other contributors / The above copyright notice and this permission notice shall be / NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE |
| @esbuild/aix-ppc64 | 0.28.2 | _包内未找到版权行，以该包 LICENSE 文件原文为准_ |
| @esbuild/android-arm | 0.28.2 | _包内未找到版权行，以该包 LICENSE 文件原文为准_ |
| @esbuild/android-arm64 | 0.28.2 | _包内未找到版权行，以该包 LICENSE 文件原文为准_ |
| @esbuild/android-x64 | 0.28.2 | _包内未找到版权行，以该包 LICENSE 文件原文为准_ |
| @esbuild/darwin-arm64 | 0.28.2 | _包内未找到版权行，以该包 LICENSE 文件原文为准_ |
| @esbuild/darwin-x64 | 0.28.2 | _包内未找到版权行，以该包 LICENSE 文件原文为准_ |
| @esbuild/freebsd-arm64 | 0.28.2 | _包内未找到版权行，以该包 LICENSE 文件原文为准_ |
| @esbuild/freebsd-x64 | 0.28.2 | _包内未找到版权行，以该包 LICENSE 文件原文为准_ |
| @esbuild/linux-arm | 0.28.2 | _包内未找到版权行，以该包 LICENSE 文件原文为准_ |
| @esbuild/linux-arm64 | 0.28.2 | _包内未找到版权行，以该包 LICENSE 文件原文为准_ |
| @esbuild/linux-ia32 | 0.28.2 | _包内未找到版权行，以该包 LICENSE 文件原文为准_ |
| @esbuild/linux-loong64 | 0.28.2 | _包内未找到版权行，以该包 LICENSE 文件原文为准_ |
| @esbuild/linux-mips64el | 0.28.2 | _包内未找到版权行，以该包 LICENSE 文件原文为准_ |
| @esbuild/linux-ppc64 | 0.28.2 | _包内未找到版权行，以该包 LICENSE 文件原文为准_ |
| @esbuild/linux-riscv64 | 0.28.2 | _包内未找到版权行，以该包 LICENSE 文件原文为准_ |
| @esbuild/linux-s390x | 0.28.2 | _包内未找到版权行，以该包 LICENSE 文件原文为准_ |
| @esbuild/linux-x64 | 0.28.2 | _包内未找到版权行，以该包 LICENSE 文件原文为准_ |
| @esbuild/netbsd-arm64 | 0.28.2 | _包内未找到版权行，以该包 LICENSE 文件原文为准_ |
| @esbuild/netbsd-x64 | 0.28.2 | _包内未找到版权行，以该包 LICENSE 文件原文为准_ |
| @esbuild/openbsd-arm64 | 0.28.2 | _包内未找到版权行，以该包 LICENSE 文件原文为准_ |
| @esbuild/openbsd-x64 | 0.28.2 | _包内未找到版权行，以该包 LICENSE 文件原文为准_ |
| @esbuild/openharmony-arm64 | 0.28.2 | _包内未找到版权行，以该包 LICENSE 文件原文为准_ |
| @esbuild/sunos-x64 | 0.28.2 | _包内未找到版权行，以该包 LICENSE 文件原文为准_ |
| @esbuild/win32-arm64 | 0.28.2 | _包内未找到版权行，以该包 LICENSE 文件原文为准_ |
| @esbuild/win32-ia32 | 0.28.2 | _包内未找到版权行，以该包 LICENSE 文件原文为准_ |
| @esbuild/win32-x64 | 0.28.2 | _包内未找到版权行，以该包 LICENSE 文件原文为准_ |
| @jridgewell/gen-mapping | 0.3.13 | Copyright 2024 Justin Ridgewell <justin@ridgewell.name> / The above copyright notice and this permission notice shall be included in / AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER |
| @jridgewell/remapping | 2.3.5 | Copyright 2024 Justin Ridgewell <justin@ridgewell.name> / The above copyright notice and this permission notice shall be included in / AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER |
| @jridgewell/resolve-uri | 3.1.2 | Copyright 2019 Justin Ridgewell <jridgewell@google.com> / The above copyright notice and this permission notice shall be included in / AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER |
| @jridgewell/sourcemap-codec | 1.6.0 | Copyright 2024 Justin Ridgewell <justin@ridgewell.name> / The above copyright notice and this permission notice shall be included in / AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER |
| @jridgewell/trace-mapping | 0.3.31 | Copyright 2024 Justin Ridgewell <justin@ridgewell.name> / The above copyright notice and this permission notice shall be included in / AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER |
| @rolldown/pluginutils | 1.0.0-rc.3 | Copyright (c) 2024-present VoidZero Inc. & Contributors / The above copyright notice and this permission notice shall be included in all / AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER |
| @rollup/rollup-android-arm-eabi | 4.67.5 | _包内未找到版权行，以该包 LICENSE 文件原文为准_ |
| @rollup/rollup-android-arm64 | 4.67.5 | _包内未找到版权行，以该包 LICENSE 文件原文为准_ |
| @rollup/rollup-android-x64 | 4.67.5 | _包内未找到版权行，以该包 LICENSE 文件原文为准_ |
| @rollup/rollup-darwin-arm64 | 4.67.5 | _包内未找到版权行，以该包 LICENSE 文件原文为准_ |
| @rollup/rollup-darwin-x64 | 4.67.5 | _包内未找到版权行，以该包 LICENSE 文件原文为准_ |
| @rollup/rollup-freebsd-arm64 | 4.67.5 | _包内未找到版权行，以该包 LICENSE 文件原文为准_ |
| @rollup/rollup-freebsd-x64 | 4.67.5 | _包内未找到版权行，以该包 LICENSE 文件原文为准_ |
| @rollup/rollup-linux-arm-gnueabihf | 4.67.5 | _包内未找到版权行，以该包 LICENSE 文件原文为准_ |
| @rollup/rollup-linux-arm-musleabihf | 4.67.5 | _包内未找到版权行，以该包 LICENSE 文件原文为准_ |
| @rollup/rollup-linux-arm64-gnu | 4.67.5 | _包内未找到版权行，以该包 LICENSE 文件原文为准_ |
| @rollup/rollup-linux-arm64-musl | 4.67.5 | _包内未找到版权行，以该包 LICENSE 文件原文为准_ |
| @rollup/rollup-linux-loong64-gnu | 4.67.5 | _包内未找到版权行，以该包 LICENSE 文件原文为准_ |
| @rollup/rollup-linux-loong64-musl | 4.67.5 | _包内未找到版权行，以该包 LICENSE 文件原文为准_ |
| @rollup/rollup-linux-ppc64-gnu | 4.67.5 | _包内未找到版权行，以该包 LICENSE 文件原文为准_ |
| @rollup/rollup-linux-ppc64-musl | 4.67.5 | _包内未找到版权行，以该包 LICENSE 文件原文为准_ |
| @rollup/rollup-linux-riscv64-gnu | 4.67.5 | _包内未找到版权行，以该包 LICENSE 文件原文为准_ |
| @rollup/rollup-linux-riscv64-musl | 4.67.5 | _包内未找到版权行，以该包 LICENSE 文件原文为准_ |
| @rollup/rollup-linux-s390x-gnu | 4.67.5 | _包内未找到版权行，以该包 LICENSE 文件原文为准_ |
| @rollup/rollup-linux-x64-gnu | 4.67.5 | _包内未找到版权行，以该包 LICENSE 文件原文为准_ |
| @rollup/rollup-linux-x64-musl | 4.67.5 | _包内未找到版权行，以该包 LICENSE 文件原文为准_ |
| @rollup/rollup-openbsd-x64 | 4.67.5 | _包内未找到版权行，以该包 LICENSE 文件原文为准_ |
| @rollup/rollup-openharmony-arm64 | 4.67.5 | _包内未找到版权行，以该包 LICENSE 文件原文为准_ |
| @rollup/rollup-win32-arm64-msvc | 4.67.5 | _包内未找到版权行，以该包 LICENSE 文件原文为准_ |
| @rollup/rollup-win32-ia32-msvc | 4.67.5 | _包内未找到版权行，以该包 LICENSE 文件原文为准_ |
| @rollup/rollup-win32-x64-gnu | 4.67.5 | _包内未找到版权行，以该包 LICENSE 文件原文为准_ |
| @rollup/rollup-win32-x64-msvc | 4.67.5 | _包内未找到版权行，以该包 LICENSE 文件原文为准_ |
| @tauri-apps/api | 2.12.4 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| @tauri-apps/cli | 2.12.4 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| @tauri-apps/cli-darwin-arm64 | 2.12.4 | _包内未找到版权行，以该包 LICENSE 文件原文为准_ |
| @tauri-apps/cli-darwin-x64 | 2.12.4 | _包内未找到版权行，以该包 LICENSE 文件原文为准_ |
| @tauri-apps/cli-linux-arm-gnueabihf | 2.12.4 | _包内未找到版权行，以该包 LICENSE 文件原文为准_ |
| @tauri-apps/cli-linux-arm64-gnu | 2.12.4 | _包内未找到版权行，以该包 LICENSE 文件原文为准_ |
| @tauri-apps/cli-linux-arm64-musl | 2.12.4 | _包内未找到版权行，以该包 LICENSE 文件原文为准_ |
| @tauri-apps/cli-linux-riscv64-gnu | 2.12.4 | _包内未找到版权行，以该包 LICENSE 文件原文为准_ |
| @tauri-apps/cli-linux-x64-gnu | 2.12.4 | _包内未找到版权行，以该包 LICENSE 文件原文为准_ |
| @tauri-apps/cli-linux-x64-musl | 2.12.4 | _包内未找到版权行，以该包 LICENSE 文件原文为准_ |
| @tauri-apps/cli-win32-arm64-msvc | 2.12.4 | _包内未找到版权行，以该包 LICENSE 文件原文为准_ |
| @tauri-apps/cli-win32-ia32-msvc | 2.12.4 | _包内未找到版权行，以该包 LICENSE 文件原文为准_ |
| @tauri-apps/cli-win32-x64-msvc | 2.12.4 | _包内未找到版权行，以该包 LICENSE 文件原文为准_ |
| @tauri-apps/plugin-dialog | 2.8.4 | PackageCopyrightText: 2019-2022, The Tauri Programme in the Commons Conservancy |
| @types/babel__core | 7.20.5 | Copyright (c) Microsoft Corporation. / The above copyright notice and this permission notice shall be included in all / AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER |
| @types/babel__generator | 7.27.0 | Copyright (c) Microsoft Corporation. / The above copyright notice and this permission notice shall be included in all / AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER |
| @types/babel__template | 7.4.4 | Copyright (c) Microsoft Corporation. / The above copyright notice and this permission notice shall be included in all / AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER |
| @types/babel__traverse | 7.28.0 | Copyright (c) Microsoft Corporation. / The above copyright notice and this permission notice shall be included in all / AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER |
| @types/estree | 1.0.10 | Copyright (c) Microsoft Corporation. / The above copyright notice and this permission notice shall be included in all / AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER |
| @types/react | 19.3.0 | Copyright (c) Microsoft Corporation. / The above copyright notice and this permission notice shall be included in all / AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER |
| @types/react-dom | 19.3.0 | Copyright (c) Microsoft Corporation. / The above copyright notice and this permission notice shall be included in all / AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER |
| @vitejs/plugin-react | 5.2.0 | Copyright (c) 2019-present, Yuxi (Evan) You and Vite contributors / The above copyright notice and this permission notice shall be included in all / AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER |
| adler2 | 2.0.1 | Copyright (C) Jonas Schievink <jonasschievink@gmail.com> / "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work |
| aho-corasick | 1.1.5 | Copyright (c) 2015 Andrew Gallant / The above copyright notice and this permission notice shall be included in / AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER |
| alloc-no-stdlib | 3.0.0 | Copyright (c) 2016 Dropbox, Inc. / 1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer. / 3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission. |
| alloc-stdlib | 0.3.0 | _包内未找到版权行，以该包 LICENSE 文件原文为准_ |
| anyhow | 1.0.104 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| base64 | 0.23.1 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| bit-set | 0.8.0 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| bit-vec | 0.8.0 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| bitflags | 2.13.2 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| block-buffer | 0.10.4 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| brotli | 9.1.1 | Copyright (c) 2016 Dropbox, Inc. / 1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer. / 3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission. |
| brotli-decompressor | 6.2.0 | Copyright (c) 2016 Dropbox, Inc. / 1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer. / 3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission. |
| browserslist | 4.29.5 | Copyright 2014 Andrey Sitnik <andrey@sitnik.es> and other contributors / The above copyright notice and this permission notice shall be included in all / COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER |
| byteorder | 1.5.0 | Copyright (c) 2015 Andrew Gallant / The above copyright notice and this permission notice shall be included in / AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER |
| bytes | 1.12.1 | Copyright (c) 2018 Carl Lerche / The above copyright notice and this permission notice / SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY |
| camino | 1.2.6 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| cargo_metadata | 0.19.2 | The above copyright notice and this permission notice / SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY |
| cargo-platform | 0.1.9 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| cfb | 0.14.0 | Copyright (c) 2017 Matthew D. Steele / The above copyright notice and this permission notice shall be included in all / AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER |
| cfg-if | 1.0.5 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| convert-source-map | 2.0.0 | Copyright 2013 Thorsten Lorenz. / The above copyright notice and this permission notice shall be / NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT |
| cookie | 0.18.2 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| cpufeatures | 0.2.17 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| crc32fast | 1.5.4 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| crossbeam-channel | 0.5.17 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| crossbeam-utils | 0.8.23 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| crypto-common | 0.1.7 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| csstype | 3.2.3 | Copyright (c) 2017-2018 Fredrik Nicol / The above copyright notice and this permission notice shall be included in all / AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER |
| ctor | 1.0.13 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| darling | 0.24.1 | Copyright (c) 2017 Ted Driggs / The above copyright notice and this permission notice shall be included in all / AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER |
| darling_core | 0.24.1 | Copyright (c) 2017 Ted Driggs / The above copyright notice and this permission notice shall be included in all / AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER |
| darling_macro | 0.24.1 | Copyright (c) 2017 Ted Driggs / The above copyright notice and this permission notice shall be included in all / AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER |
| debug | 4.4.3 | Copyright (c) 2014-2017 TJ Holowaychuk <tj@vision-media.ca> / Copyright (c) 2018-2021 Josh Junon / The above copyright notice and this permission notice shall be included in all copies or substantial |
| deranged | 0.5.9 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| derive_more | 2.1.1 | Copyright (c) 2016 Jelte Fennema / The above copyright notice and this permission notice shall be included in all / AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER |
| derive_more-impl | 2.1.1 | Copyright (c) 2016 Jelte Fennema / The above copyright notice and this permission notice shall be included in all / AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER |
| digest | 0.10.7 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| dirs | 7.0.0 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| dirs-sys | 0.5.0 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| displaydoc | 0.2.7 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| dom_query | 0.28.0 | Copyright (c) 2023 Mykola Humanov / The above copyright notice and this permission notice shall be included in all / AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER |
| dpi | 0.1.2 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| dtoa | 1.0.11 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| dunce | 1.0.5 | exclusive Copyright and Related Rights (defined below) upon the creator / is an owner of Copyright and Related Rights in the Work, voluntarily / terms, with knowledge of his or her Copyright and Related Rights in the |
| dyn-clone | 1.0.20 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| electron-to-chromium | 1.5.476 | Copyright 2018 Kilian Valkhof |
| equivalent | 1.0.3 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| erased-serde | 0.4.11 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| esbuild | 0.28.2 | Copyright (c) 2020 Evan Wallace / The above copyright notice and this permission notice shall be included in all / AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER |
| escalade | 3.2.0 | Copyright (c) Luke Edwards <luke.edwards05@gmail.com> (lukeed.com) / The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. |
| fastrand | 2.5.0 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| fdeflate | 0.3.7 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| fdir | 6.5.0 | Copyright 2023 Abdullah Atta / The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. |
| flate2 | 1.1.10 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| fnv | 1.0.7 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| form_urlencoded | 1.2.2 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| fsevents | 2.3.3 | _包内未找到版权行，以该包 LICENSE 文件原文为准_ |
| generic-array | 0.14.7 | Copyright (c) 2015 Bartłomiej Kamiński / The above copyright notice and this permission notice shall be included in all / AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER |
| gensync | 1.0.0-beta.2 | Copyright 2018 Logan Smyth <loganfsmyth@gmail.com> / The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. |
| getrandom | 0.3.4 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| getrandom | 0.4.3 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| glob | 0.3.4 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| hashbrown | 0.12.3 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| hashbrown | 0.17.1 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| heck | 0.5.0 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| html5ever | 0.39.0 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| http | 1.5.0 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| ico | 0.6.0 | Copyright (c) 2018 Matthew D. Steele / The above copyright notice and this permission notice shall be included in all / AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER |
| ident_case | 1.0.1 | The above copyright notice and this permission notice shall be included in all / AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER |
| idna | 1.1.0 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| idna_adapter | 1.2.2 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| indexmap | 1.9.3 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| indexmap | 2.14.2 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| infer | 0.22.0 | Copyright (c) 2019 Bojan / The above copyright notice and this permission notice shall be included in all / AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER |
| itoa | 1.0.18 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| js-tokens | 4.0.0 | Copyright (c) 2014, 2015, 2016, 2017, 2018 Simon Lydell / The above copyright notice and this permission notice shall be included in / AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER |
| jsesc | 3.1.0 | Copyright Mathias Bynens <https://mathiasbynens.be/> / The above copyright notice and this permission notice shall be / NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE |
| json-patch | 4.2.0 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| json5 | 2.2.3 | Copyright (c) 2012-2018 Aseem Kishore, and [others]. / The above copyright notice and this permission notice shall be included in all / AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER |
| jsonptr | 0.7.1 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| keyboard-types | 0.8.3 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| libc | 0.2.191 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| lock_api | 0.4.14 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| log | 0.4.35 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| lru-cache | 5.1.1 | Copyright (c) Isaac Z. Schlueter and Contributors / copyright notice and this permission notice appear in all copies. |
| markup5ever | 0.39.0 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| memchr | 2.8.3 | Copyright (c) 2015 Andrew Gallant / The above copyright notice and this permission notice shall be included in / AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER |
| mime | 0.3.17 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| miniz_oxide | 0.8.9 | Copyright 2013-2014 RAD Game Tools and Valve Software / Copyright 2010-2014 Rich Geldreich and Tenacious Software LLC / Copyright (c) 2017 Frommi |
| miniz_oxide | 0.9.1 | Copyright 2013-2014 RAD Game Tools and Valve Software / Copyright 2010-2014 Rich Geldreich and Tenacious Software LLC / Copyright (c) 2017 Frommi |
| ms | 2.1.3 | Copyright (c) 2020 Vercel, Inc. / The above copyright notice and this permission notice shall be included in all / AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER |
| muda | 0.20.0 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| nanoid | 3.3.20 | Copyright 2017 Andrey Sitnik <andrey@sitnik.ru> / The above copyright notice and this permission notice shall be included in all / COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER |
| new_debug_unreachable | 1.0.6 | Copyright (c) 2015 Jonathan Reem / The above copyright notice and this permission notice / SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY |
| node-releases | 2.0.63 | Copyright (c) 2017 Sergey Rubanov (https://github.com/chicoxyzzy) / The above copyright notice and this permission notice shall be included in / AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER |
| num-conv | 0.2.2 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| once_cell | 1.21.4 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| parking_lot | 0.12.5 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| parking_lot_core | 0.9.12 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| percent-encoding | 2.3.2 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| phf | 0.13.1 | Copyright (c) 2014-2022 Steven Fackler, Yuki Okushi / The above copyright notice and this permission notice shall be included in all / COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER |
| phf_generator | 0.13.1 | Copyright (c) 2014-2022 Steven Fackler, Yuki Okushi / The above copyright notice and this permission notice shall be included in all / COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER |
| phf_macros | 0.13.1 | Copyright (c) 2014-2022 Steven Fackler, Yuki Okushi / The above copyright notice and this permission notice shall be included in all / COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER |
| phf_shared | 0.13.1 | Copyright (c) 2014-2022 Steven Fackler, Yuki Okushi / The above copyright notice and this permission notice shall be included in all / COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER |
| picocolors | 1.1.1 | Copyright (c) 2021-2024 Oleksii Raspopov, Kostiantyn Denysov, Anton Verinov / copyright notice and this permission notice appear in all copies. |
| picomatch | 4.0.7 | Copyright (c) 2017-present, Jon Schlinkert. / The above copyright notice and this permission notice shall be included in / AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER |
| pin-project-lite | 0.2.17 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| plist | 1.10.3 | Copyright (c) 2015 Edward Barnard / The above copyright notice and this permission notice shall be included in all / AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER |
| png | 0.18.1 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| postcss | 8.5.32 | Copyright 2013 Andrey Sitnik <andrey@sitnik.es> / The above copyright notice and this permission notice shall be included in all / COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER |
| powerfmt | 0.2.1 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| precomputed-hash | 0.1.1 | Copyright (c) 2017 Emilio Cobos Álvarez / The above copyright notice and this permission notice shall be included in all / AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER |
| proc-macro2 | 1.0.107 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| quick-xml | 0.42.0 | Copyright (c) 2016 Johann Tuffe / The above copyright notice and this permission notice shall be included in / AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER |
| quote | 1.0.47 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| raw-window-handle | 0.6.2 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| react | 19.3.1 | Copyright (c) Meta Platforms, Inc. and affiliates. / The above copyright notice and this permission notice shall be included in all / AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER |
| react-dom | 19.3.1 | Copyright (c) Meta Platforms, Inc. and affiliates. / The above copyright notice and this permission notice shall be included in all / AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER |
| react-refresh | 0.18.0 | Copyright (c) Meta Platforms, Inc. and affiliates. / The above copyright notice and this permission notice shall be included in all / AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER |
| regex | 1.13.1 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| regex-automata | 0.4.18 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| regex-syntax | 0.8.11 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| rfd | 0.17.2 | Copyright (c) 2022 Bartłomiej Maryńczak / The above copyright notice and this permission notice shall be included in all / AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER |
| rollup | 4.67.5 | Copyright (c) 2017 [these people](https://github.com/rollup/rollup/graphs/contributors) / The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. / > Copyright 2024 Justin Ridgewell <justin@ridgewell.name> |
| rustc-hash | 2.1.3 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| same-file | 1.0.6 | Copyright (c) 2017 Andrew Gallant / The above copyright notice and this permission notice shall be included in / AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER |
| scheduler | 0.28.0 | Copyright (c) Meta Platforms, Inc. and affiliates. / The above copyright notice and this permission notice shall be included in all / AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER |
| schemars | 0.8.22 | Copyright (c) 2019 Graham Esau / The above copyright notice and this permission notice shall be included in all / AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER |
| schemars_derive | 0.8.22 | Copyright (c) 2019 Graham Esau / The above copyright notice and this permission notice shall be included in all / AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER |
| scopeguard | 1.2.0 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| semver | 1.0.28 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| semver | 6.3.2 | Copyright (c) Isaac Z. Schlueter and Contributors / copyright notice and this permission notice appear in all copies. |
| serde | 1.0.229 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| serde_core | 1.0.229 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| serde_derive | 1.0.229 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| serde_derive_internals | 0.29.1 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| serde_json | 1.0.154 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| serde_repr | 0.1.21 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| serde_spanned | 1.1.2 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| serde_with | 3.24.0 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| serde_with_macros | 3.24.0 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| serde-untagged | 0.1.9 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| serialize-to-javascript | 0.1.2 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| serialize-to-javascript-impl | 0.1.2 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| servo_arc | 0.4.3 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| sha2 | 0.10.9 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| simd-adler32 | 0.3.10 | Copyright (c) [2021] [Marvin Countryman] / The above copyright notice and this permission notice shall be included in all / AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER |
| siphasher | 1.0.4 | Copyright 2012-2016 The Rust Project Developers. / Copyright 2016-2026 Frank Denis. / "Licensor" shall mean the copyright owner or entity authorized by |
| smallvec | 1.16.4 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| softbuffer | 0.4.8 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| source-map-js | 1.2.2 | Copyright (c) 2009-2011, Mozilla Foundation and contributors / * Redistributions of source code must retain the above copyright notice, this / * Redistributions in binary form must reproduce the above copyright notice, |
| stable_deref_trait | 1.2.1 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| string_cache | 0.9.0 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| strsim | 0.11.1 | Copyright (c) 2015 Danny Guo / Copyright (c) 2016 Titus Wormer <tituswormer@gmail.com> / Copyright (c) 2018 Akash Kurdekar |
| syn | 2.0.119 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| syn | 3.0.9 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| synstructure | 0.14.0 | Copyright 2016 Nika Layzell / The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. |
| tauri | 2.12.5 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| tauri-build | 2.7.4 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| tauri-codegen | 2.7.4 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| tauri-macros | 2.7.4 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| tauri-plugin-dialog | 2.8.4 | PackageCopyrightText: 2019-2022, The Tauri Programme in the Commons Conservancy / "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work |
| tauri-plugin-fs | 2.7.1 | PackageCopyrightText: 2019-2022, The Tauri Programme in the Commons Conservancy / "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work |
| tauri-runtime | 2.12.2 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| tauri-runtime-wry | 2.12.3 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| tauri-utils | 2.10.2 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| tendril | 0.5.1 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| thiserror | 2.0.21 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| thiserror-impl | 2.0.21 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| time | 0.3.55 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| time-core | 0.1.9 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| time-macros | 0.2.32 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| tinyglobby | 0.2.17 | Copyright (c) 2024 Madeline Gurriarán / The above copyright notice and this permission notice shall be included in all / AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER |
| tokio | 1.54.1 | Copyright (c) Tokio Contributors / The above copyright notice and this permission notice shall be included in all / AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER |
| toml | 1.2.0+spec-1.1.0 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| toml_datetime | 1.1.2+spec-1.1.0 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| toml_parser | 1.1.5+spec-1.1.0 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| toml_writer | 1.2.0+spec-1.1.0 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| tracing | 0.1.44 | Copyright (c) 2019 Tokio Contributors / The above copyright notice and this permission notice / SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY |
| tracing-core | 0.1.36 | Copyright (c) 2019 Tokio Contributors / The above copyright notice and this permission notice / SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY |
| typeid | 1.0.3 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| typenum | 1.20.1 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| unicode-ident | 1.0.27 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| unicode-segmentation | 1.13.3 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| update-browserslist-db | 1.3.4 | Copyright 2022 Andrey Sitnik <andrey@sitnik.es> and other contributors / The above copyright notice and this permission notice shall be included in all / COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER |
| url | 2.5.8 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| urlpattern | 0.6.0 | Copyright (c) 2021 the Deno authors / The above copyright notice and this permission notice shall be included in all / AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER |
| utf_types | 1.0.0 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| utf8_iter | 1.1.0 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| uuid | 1.29.0 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| vite | 7.3.7 | Copyright (c) 2019-present, VoidZero Inc. and Vite contributors / The above copyright notice and this permission notice shall be included in all / AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER |
| walkdir | 2.5.0 | Copyright (c) 2015 Andrew Gallant / The above copyright notice and this permission notice shall be included in / AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER |
| web_atoms | 0.2.6 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| web-time | 1.1.0 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| webview2-com | 0.39.1 | _包内未找到版权行，以该包 LICENSE 文件原文为准_ |
| webview2-com-macros | 0.8.1 | _包内未找到版权行，以该包 LICENSE 文件原文为准_ |
| webview2-com-sys | 0.39.1 | _包内未找到版权行，以该包 LICENSE 文件原文为准_ |
| winapi-util | 0.1.11 | Copyright (c) 2017 Andrew Gallant / The above copyright notice and this permission notice shall be included in / AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER |
| window-vibrancy | 0.8.1 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| windows | 0.62.2 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| windows-collections | 0.3.2 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| windows-core | 0.62.2 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| windows-future | 0.3.2 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| windows-implement | 0.60.2 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| windows-interface | 0.59.3 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| windows-link | 0.2.1 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| windows-numerics | 0.3.1 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| windows-result | 0.4.1 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| windows-strings | 0.5.1 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| windows-sys | 0.61.2 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| windows-threading | 0.2.1 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| windows-version | 0.1.7 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| winnow | 1.0.4 | The above copyright notice and this permission notice shall be / NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE |
| wry | 0.57.1 | "Licensor" shall mean the copyright owner or entity authorized by / copyright notice that is included in or attached to the work / submitted to Licensor for inclusion in the Work by the copyright owner |
| yallist | 3.1.1 | Copyright (c) Isaac Z. Schlueter and Contributors / copyright notice and this permission notice appear in all copies. |
| zmij | 1.0.23 | The above copyright notice and this permission notice / SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY |
| zustand | 5.0.16 | Copyright (c) 2019 Paul Henschel / The above copyright notice and this permission notice shall be included in all / AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER |

## 7. 其他宽松许可（Unicode / Zlib / CC0 / 0BSD / Unlicense / CC-BY）

| 包 | 版本 | 许可证 | 分组 |
| --- | --- | --- | --- |
| adler2 | 2.0.1 | 0BSD OR MIT OR Apache-2.0 | 运行时 |
| aho-corasick | 1.1.5 | Unlicense OR MIT | 运行时 |
| byteorder | 1.5.0 | Unlicense OR MIT | 运行时 |
| caniuse-lite | 1.0.30001820 | CC-BY-4.0 | 构建期 |
| dunce | 1.0.5 | CC0-1.0 OR MIT-0 OR Apache-2.0 | 运行时 |
| foldhash | 0.2.0 | Zlib | 运行时 |
| icu_collections | 2.4.0 | Unicode-3.0 | 运行时 |
| icu_locale_core | 2.4.0 | Unicode-3.0 | 运行时 |
| icu_normalizer | 2.4.0 | Unicode-3.0 | 运行时 |
| icu_normalizer_data | 2.4.0 | Unicode-3.0 | 运行时 |
| icu_properties | 2.4.0 | Unicode-3.0 | 运行时 |
| icu_properties_data | 2.4.0 | Unicode-3.0 | 运行时 |
| icu_provider | 2.4.0 | Unicode-3.0 | 运行时 |
| litemap | 0.8.3 | Unicode-3.0 | 运行时 |
| memchr | 2.8.3 | Unlicense OR MIT | 运行时 |
| miniz_oxide | 0.8.9 | MIT OR Zlib OR Apache-2.0 | 运行时 |
| miniz_oxide | 0.9.1 | MIT OR Zlib OR Apache-2.0 | 运行时 |
| potential_utf | 0.1.6 | Unicode-3.0 | 运行时 |
| raw-window-handle | 0.6.2 | MIT OR Apache-2.0 OR Zlib | 运行时 |
| same-file | 1.0.6 | Unlicense/MIT | 运行时 |
| tinystr | 0.8.5 | Unicode-3.0 | 运行时 |
| unicode-ident | 1.0.27 | (MIT OR Apache-2.0) AND Unicode-3.0 | 运行时 |
| walkdir | 2.5.0 | Unlicense/MIT | 运行时 |
| winapi-util | 0.1.11 | Unlicense OR MIT | 运行时 |
| writeable | 0.6.4 | Unicode-3.0 | 运行时 |
| yoke | 0.8.4 | Unicode-3.0 | 运行时 |
| yoke-derive | 0.8.4 | Unicode-3.0 | 运行时 |
| zerofrom | 0.1.8 | Unicode-3.0 | 运行时 |
| zerofrom-derive | 0.1.8 | Unicode-3.0 | 运行时 |
| zerotrie | 0.2.5 | Unicode-3.0 | 运行时 |
| zerovec | 0.11.9 | Unicode-3.0 | 运行时 |
| zerovec-derive | 0.11.7 | Unicode-3.0 | 运行时 |

说明：`Unicode-3.0` 是 Unicode 联盟的宽松许可（保留版权与许可声明即可）；`Zlib`、`0BSD`、`CC0-1.0`、`Unlicense` 均允许自由使用；`CC-BY-4.0` 需要署名（对应包已在表中列出）。

## 8. 双许可 / 多许可依赖（160，未单方面选择）

这些包的许可证字段是「A OR B」或「A AND B」形式。本文件**不替它们选择**其中一种，按原始字段完整记录；使用方需自行满足所选分支（或全部分支）的条件。

| 包 | 版本 | 许可证（原始字段） | 分组 |
| --- | --- | --- | --- |
| @tauri-apps/api | 2.12.4 | Apache-2.0 OR MIT | 运行时 |
| @tauri-apps/cli | 2.12.4 | Apache-2.0 OR MIT | 构建期 |
| @tauri-apps/cli-darwin-arm64 | 2.12.4 | Apache-2.0 OR MIT | 构建期 |
| @tauri-apps/cli-darwin-x64 | 2.12.4 | Apache-2.0 OR MIT | 构建期 |
| @tauri-apps/cli-linux-arm-gnueabihf | 2.12.4 | Apache-2.0 OR MIT | 构建期 |
| @tauri-apps/cli-linux-arm64-gnu | 2.12.4 | Apache-2.0 OR MIT | 构建期 |
| @tauri-apps/cli-linux-arm64-musl | 2.12.4 | Apache-2.0 OR MIT | 构建期 |
| @tauri-apps/cli-linux-riscv64-gnu | 2.12.4 | Apache-2.0 OR MIT | 构建期 |
| @tauri-apps/cli-linux-x64-gnu | 2.12.4 | Apache-2.0 OR MIT | 构建期 |
| @tauri-apps/cli-linux-x64-musl | 2.12.4 | Apache-2.0 OR MIT | 构建期 |
| @tauri-apps/cli-win32-arm64-msvc | 2.12.4 | Apache-2.0 OR MIT | 构建期 |
| @tauri-apps/cli-win32-ia32-msvc | 2.12.4 | Apache-2.0 OR MIT | 构建期 |
| @tauri-apps/cli-win32-x64-msvc | 2.12.4 | Apache-2.0 OR MIT | 构建期 |
| @tauri-apps/plugin-dialog | 2.8.4 | MIT OR Apache-2.0 | 运行时 |
| adler2 | 2.0.1 | 0BSD OR MIT OR Apache-2.0 | 运行时 |
| aho-corasick | 1.1.5 | Unlicense OR MIT | 运行时 |
| anyhow | 1.0.104 | MIT OR Apache-2.0 | 运行时 |
| base64 | 0.23.1 | MIT OR Apache-2.0 | 运行时 |
| bit-set | 0.8.0 | Apache-2.0 OR MIT | 运行时 |
| bit-vec | 0.8.0 | Apache-2.0 OR MIT | 运行时 |
| bitflags | 2.13.2 | MIT OR Apache-2.0 | 运行时 |
| block-buffer | 0.10.4 | MIT OR Apache-2.0 | 运行时 |
| brotli | 9.1.1 | BSD-3-Clause AND MIT | 运行时 |
| brotli-decompressor | 6.2.0 | BSD-3-Clause/MIT | 运行时 |
| byteorder | 1.5.0 | Unlicense OR MIT | 运行时 |
| camino | 1.2.6 | MIT OR Apache-2.0 | 运行时 |
| cargo-platform | 0.1.9 | MIT OR Apache-2.0 | 运行时 |
| cfg-if | 1.0.5 | MIT OR Apache-2.0 | 运行时 |
| cookie | 0.18.2 | MIT OR Apache-2.0 | 运行时 |
| cpufeatures | 0.2.17 | MIT OR Apache-2.0 | 运行时 |
| crc32fast | 1.5.4 | MIT OR Apache-2.0 | 运行时 |
| crossbeam-channel | 0.5.17 | MIT OR Apache-2.0 | 运行时 |
| crossbeam-utils | 0.8.23 | MIT OR Apache-2.0 | 运行时 |
| crypto-common | 0.1.7 | MIT OR Apache-2.0 | 运行时 |
| ctor | 1.0.13 | Apache-2.0 OR MIT | 运行时 |
| deranged | 0.5.9 | MIT OR Apache-2.0 | 运行时 |
| digest | 0.10.7 | MIT OR Apache-2.0 | 运行时 |
| dirs | 7.0.0 | MIT OR Apache-2.0 | 运行时 |
| dirs-sys | 0.5.0 | MIT OR Apache-2.0 | 运行时 |
| displaydoc | 0.2.7 | MIT OR Apache-2.0 | 运行时 |
| dpi | 0.1.2 | Apache-2.0 AND MIT | 运行时 |
| dtoa | 1.0.11 | MIT OR Apache-2.0 | 运行时 |
| dunce | 1.0.5 | CC0-1.0 OR MIT-0 OR Apache-2.0 | 运行时 |
| dyn-clone | 1.0.20 | MIT OR Apache-2.0 | 运行时 |
| equivalent | 1.0.3 | Apache-2.0 OR MIT | 运行时 |
| erased-serde | 0.4.11 | MIT OR Apache-2.0 | 运行时 |
| fastrand | 2.5.0 | Apache-2.0 OR MIT | 运行时 |
| fdeflate | 0.3.7 | MIT OR Apache-2.0 | 运行时 |
| flate2 | 1.1.10 | MIT OR Apache-2.0 | 运行时 |
| fnv | 1.0.7 | Apache-2.0 / MIT | 运行时 |
| form_urlencoded | 1.2.2 | MIT OR Apache-2.0 | 运行时 |
| getrandom | 0.3.4 | MIT OR Apache-2.0 | 运行时 |
| getrandom | 0.4.3 | MIT OR Apache-2.0 | 运行时 |
| glob | 0.3.4 | MIT OR Apache-2.0 | 运行时 |
| hashbrown | 0.12.3 | MIT OR Apache-2.0 | 运行时 |
| hashbrown | 0.17.1 | MIT OR Apache-2.0 | 运行时 |
| heck | 0.5.0 | MIT OR Apache-2.0 | 运行时 |
| html5ever | 0.39.0 | MIT OR Apache-2.0 | 运行时 |
| http | 1.5.0 | MIT OR Apache-2.0 | 运行时 |
| ident_case | 1.0.1 | MIT/Apache-2.0 | 运行时 |
| idna | 1.1.0 | MIT OR Apache-2.0 | 运行时 |
| idna_adapter | 1.2.2 | Apache-2.0 OR MIT | 运行时 |
| indexmap | 1.9.3 | Apache-2.0 OR MIT | 运行时 |
| indexmap | 2.14.2 | Apache-2.0 OR MIT | 运行时 |
| itoa | 1.0.18 | MIT OR Apache-2.0 | 运行时 |
| json-patch | 4.2.0 | MIT/Apache-2.0 | 运行时 |
| jsonptr | 0.7.1 | MIT OR Apache-2.0 | 运行时 |
| keyboard-types | 0.8.3 | MIT OR Apache-2.0 | 运行时 |
| libc | 0.2.191 | MIT OR Apache-2.0 | 运行时 |
| lock_api | 0.4.14 | MIT OR Apache-2.0 | 运行时 |
| log | 0.4.35 | MIT OR Apache-2.0 | 运行时 |
| markup5ever | 0.39.0 | MIT OR Apache-2.0 | 运行时 |
| memchr | 2.8.3 | Unlicense OR MIT | 运行时 |
| mime | 0.3.17 | MIT OR Apache-2.0 | 运行时 |
| miniz_oxide | 0.8.9 | MIT OR Zlib OR Apache-2.0 | 运行时 |
| miniz_oxide | 0.9.1 | MIT OR Zlib OR Apache-2.0 | 运行时 |
| muda | 0.20.0 | Apache-2.0 OR MIT | 运行时 |
| num-conv | 0.2.2 | MIT OR Apache-2.0 | 运行时 |
| once_cell | 1.21.4 | MIT OR Apache-2.0 | 运行时 |
| parking_lot | 0.12.5 | MIT OR Apache-2.0 | 运行时 |
| parking_lot_core | 0.9.12 | MIT OR Apache-2.0 | 运行时 |
| percent-encoding | 2.3.2 | MIT OR Apache-2.0 | 运行时 |
| pin-project-lite | 0.2.17 | Apache-2.0 OR MIT | 运行时 |
| png | 0.18.1 | MIT OR Apache-2.0 | 运行时 |
| powerfmt | 0.2.1 | MIT OR Apache-2.0 | 运行时 |
| proc-macro2 | 1.0.107 | MIT OR Apache-2.0 | 运行时 |
| quote | 1.0.47 | MIT OR Apache-2.0 | 运行时 |
| raw-window-handle | 0.6.2 | MIT OR Apache-2.0 OR Zlib | 运行时 |
| regex | 1.13.1 | MIT OR Apache-2.0 | 运行时 |
| regex-automata | 0.4.18 | MIT OR Apache-2.0 | 运行时 |
| regex-syntax | 0.8.11 | MIT OR Apache-2.0 | 运行时 |
| rustc-hash | 2.1.3 | Apache-2.0 OR MIT | 运行时 |
| scopeguard | 1.2.0 | MIT OR Apache-2.0 | 运行时 |
| semver | 1.0.28 | MIT OR Apache-2.0 | 运行时 |
| serde | 1.0.229 | MIT OR Apache-2.0 | 运行时 |
| serde_core | 1.0.229 | MIT OR Apache-2.0 | 运行时 |
| serde_derive | 1.0.229 | MIT OR Apache-2.0 | 运行时 |
| serde_derive_internals | 0.29.1 | MIT OR Apache-2.0 | 运行时 |
| serde_json | 1.0.154 | MIT OR Apache-2.0 | 运行时 |
| serde_repr | 0.1.21 | MIT OR Apache-2.0 | 运行时 |
| serde_spanned | 1.1.2 | MIT OR Apache-2.0 | 运行时 |
| serde_with | 3.24.0 | MIT OR Apache-2.0 | 运行时 |
| serde_with_macros | 3.24.0 | MIT OR Apache-2.0 | 运行时 |
| serde-untagged | 0.1.9 | MIT OR Apache-2.0 | 运行时 |
| serialize-to-javascript | 0.1.2 | MIT OR Apache-2.0 | 运行时 |
| serialize-to-javascript-impl | 0.1.2 | MIT OR Apache-2.0 | 运行时 |
| servo_arc | 0.4.3 | MIT OR Apache-2.0 | 运行时 |
| sha2 | 0.10.9 | MIT OR Apache-2.0 | 运行时 |
| siphasher | 1.0.4 | MIT OR Apache-2.0 | 运行时 |
| smallvec | 1.16.4 | MIT OR Apache-2.0 | 运行时 |
| softbuffer | 0.4.8 | MIT OR Apache-2.0 | 运行时 |
| stable_deref_trait | 1.2.1 | MIT OR Apache-2.0 | 运行时 |
| string_cache | 0.9.0 | MIT OR Apache-2.0 | 运行时 |
| syn | 2.0.119 | MIT OR Apache-2.0 | 运行时 |
| syn | 3.0.9 | MIT OR Apache-2.0 | 运行时 |
| tauri | 2.12.5 | Apache-2.0 OR MIT | 运行时 |
| tauri-build | 2.7.4 | Apache-2.0 OR MIT | 构建期 |
| tauri-codegen | 2.7.4 | Apache-2.0 OR MIT | 运行时 |
| tauri-macros | 2.7.4 | Apache-2.0 OR MIT | 运行时 |
| tauri-plugin-dialog | 2.8.4 | Apache-2.0 OR MIT | 运行时 |
| tauri-plugin-fs | 2.7.1 | Apache-2.0 OR MIT | 运行时 |
| tauri-runtime | 2.12.2 | Apache-2.0 OR MIT | 运行时 |
| tauri-runtime-wry | 2.12.3 | Apache-2.0 OR MIT | 运行时 |
| tauri-utils | 2.10.2 | Apache-2.0 OR MIT | 运行时 |
| tendril | 0.5.1 | MIT OR Apache-2.0 | 运行时 |
| thiserror | 2.0.21 | MIT OR Apache-2.0 | 运行时 |
| thiserror-impl | 2.0.21 | MIT OR Apache-2.0 | 运行时 |
| time | 0.3.55 | MIT OR Apache-2.0 | 运行时 |
| time-core | 0.1.9 | MIT OR Apache-2.0 | 运行时 |
| time-macros | 0.2.32 | MIT OR Apache-2.0 | 运行时 |
| toml | 1.2.0+spec-1.1.0 | MIT OR Apache-2.0 | 运行时 |
| toml_datetime | 1.1.2+spec-1.1.0 | MIT OR Apache-2.0 | 运行时 |
| toml_parser | 1.1.5+spec-1.1.0 | MIT OR Apache-2.0 | 运行时 |
| toml_writer | 1.2.0+spec-1.1.0 | MIT OR Apache-2.0 | 运行时 |
| typeid | 1.0.3 | MIT OR Apache-2.0 | 运行时 |
| typenum | 1.20.1 | MIT OR Apache-2.0 | 运行时 |
| unicode-ident | 1.0.27 | (MIT OR Apache-2.0) AND Unicode-3.0 | 运行时 |
| unicode-segmentation | 1.13.3 | MIT OR Apache-2.0 | 运行时 |
| url | 2.5.8 | MIT OR Apache-2.0 | 运行时 |
| utf_types | 1.0.0 | Apache-2.0 OR MIT | 运行时 |
| utf8_iter | 1.1.0 | Apache-2.0 OR MIT | 运行时 |
| uuid | 1.29.0 | Apache-2.0 OR MIT | 运行时 |
| web_atoms | 0.2.6 | MIT OR Apache-2.0 | 运行时 |
| web-time | 1.1.0 | MIT OR Apache-2.0 | 运行时 |
| winapi-util | 0.1.11 | Unlicense OR MIT | 运行时 |
| window-vibrancy | 0.8.1 | Apache-2.0 OR MIT | 运行时 |
| windows | 0.62.2 | MIT OR Apache-2.0 | 运行时 |
| windows-collections | 0.3.2 | MIT OR Apache-2.0 | 运行时 |
| windows-core | 0.62.2 | MIT OR Apache-2.0 | 运行时 |
| windows-future | 0.3.2 | MIT OR Apache-2.0 | 运行时 |
| windows-implement | 0.60.2 | MIT OR Apache-2.0 | 运行时 |
| windows-interface | 0.59.3 | MIT OR Apache-2.0 | 运行时 |
| windows-link | 0.2.1 | MIT OR Apache-2.0 | 运行时 |
| windows-numerics | 0.3.1 | MIT OR Apache-2.0 | 运行时 |
| windows-result | 0.4.1 | MIT OR Apache-2.0 | 运行时 |
| windows-strings | 0.5.1 | MIT OR Apache-2.0 | 运行时 |
| windows-sys | 0.61.2 | MIT OR Apache-2.0 | 运行时 |
| windows-threading | 0.2.1 | MIT OR Apache-2.0 | 运行时 |
| windows-version | 0.1.7 | MIT OR Apache-2.0 | 运行时 |
| wry | 0.57.1 | Apache-2.0 OR MIT | 运行时 |

## 9. 许可证字段缺失 / UNKNOWN（0）

无。`Cargo.lock` 与 `package-lock.json` 中所有第三方包的许可证字段均可读；`@rename/foundation` 为本项目 workspace 包，不在此列。

## 10. 弱 copyleft：MPL-2.0（5，已接受）

以下包使用 **MPL-2.0**（文件级弱 copyleft）。**已接受（决策日期 2026-11-06）**：这些包的状态是**未修改源码、仅按原样链接**，因此**不触发 MPL-2.0 的源码公开义务**（MPL 的义务针对被修改的 MPL 文件本身，不要求把链接它们的更大作品整体改为 MPL）。

| 包 | 版本 | 许可证 | 分组 |
| --- | --- | --- | --- |
| cssparser | 0.37.0 | MPL-2.0 | 运行时 |
| cssparser-macros | 0.7.1 | MPL-2.0 | 运行时 |
| dtoa-short | 0.3.5 | MPL-2.0 | 运行时 |
| option-ext | 0.2.0 | MPL-2.0 | 运行时 |
| selectors | 0.38.0 | MPL-2.0 | 运行时 |

均为 Tauri 依赖树的传递依赖（HTML/CSS 解析栈与 `dirs` 路径库），本项目未修改、未替换它们。

**长期约束**：若以后修改上述任一 MPL 文件的源码，**必须公开修改后的文件**（以 MPL-2.0 发布相应文件），并在本文件中记录改动。

## 11. 强 copyleft 扫描结论

**未发现 GPL / AGPL / SSPL 依赖**（对全部运行时与构建期依赖的许可证字段做了 `GPL|AGPL|SSPL` 检索，0 命中）。

## 12. 系统组件：WebView2

Windows 上的 **Microsoft Edge WebView2 Runtime** 是操作系统/浏览器提供的**系统组件**，由 Windows 或 Edge 更新维护，**不随本项目的 MSI / NSIS 安装包分发**，因此不列为本项目再分发的二进制，也不在本文件的包清单内。安装包只声明依赖它（Tauri 的 `webviewInstallMode`），未打包其运行时。

## 13. 本项目自身

- `rename-studio`（Tauri 壳 crate）与 `ffrn-core`：MIT，见根 `LICENSE`（`ffrn-core` 的 crate 元数据也标注 `MIT`）。
- `@rename/foundation`（`app/packages/foundation`）：本项目 workspace 包，适用根 `LICENSE`。
