//! 系统文件类型图标：按扩展名取与资源管理器一致的 16×16 图标，编码为 PNG + base64 交给前端。
//! 只在 Windows 上实现；其它平台返回空列表，由前端回退到内置图标。

use serde::Serialize;

/// 一类图标的提取结果：`ext` 为前端使用的 key（小写扩展名或 `folder`），`png` 为 base64 的 PNG。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileTypeIcon {
    pub ext: String,
    pub png: String,
}

/// 批量取图标；未知扩展名由系统给出通用文件图标，单条失败只跳过该条。
pub fn icons_for(exts: &[String]) -> Vec<FileTypeIcon> {
    #[cfg(windows)]
    {
        win::icons_for(exts)
    }
    #[cfg(not(windows))]
    {
        let _ = exts;
        Vec::new()
    }
}

#[cfg(windows)]
mod win {
    use std::ffi::{c_void, OsStr};
    use std::os::windows::ffi::OsStrExt;

    use base64::Engine as _;
    use windows::core::PCWSTR;
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetDC, ReleaseDC,
        SelectObject, BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS, HGDIOBJ, BI_RGB,
    };
    use windows::Win32::Storage::FileSystem::{
        FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL, FILE_FLAGS_AND_ATTRIBUTES,
    };
    use windows::Win32::UI::Shell::{
        SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_SMALLICON, SHGFI_USEFILEATTRIBUTES,
    };
    use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, DrawIconEx, DI_NORMAL, HICON};

    use super::FileTypeIcon;

    /// 与资源管理器「小图标」一致的 16×16。
    const SIZE: i32 = 16;

    pub fn icons_for(exts: &[String]) -> Vec<FileTypeIcon> {
        let mut out = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for ext in exts {
            let key = ext.trim().to_lowercase();
            if key.is_empty() || !seen.insert(key.clone()) {
                continue;
            }
            let (path, attrs) = if key == "folder" {
                ("C:\\renomio-icon".to_string(), FILE_ATTRIBUTE_DIRECTORY)
            } else {
                (
                    format!("C:\\renomio-icon.{key}"),
                    FILE_ATTRIBUTE_NORMAL,
                )
            };
            if let Some(png) = icon_png(&path, attrs) {
                out.push(FileTypeIcon { ext: key, png });
            }
        }
        out
    }

    fn wide(s: &str) -> Vec<u16> {
        OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
    }

    /// 假路径 + `SHGFI_USEFILEATTRIBUTES`：不要求文件真实存在，只按扩展名取关联图标。
    fn icon_png(path: &str, attrs: FILE_FLAGS_AND_ATTRIBUTES) -> Option<String> {
        let path_w = wide(path);
        let mut info: SHFILEINFOW = unsafe { std::mem::zeroed() };
        let flags = SHGFI_ICON | SHGFI_SMALLICON | SHGFI_USEFILEATTRIBUTES;
        let ok = unsafe {
            SHGetFileInfoW(
                PCWSTR(path_w.as_ptr()),
                attrs,
                Some(&mut info as *mut SHFILEINFOW),
                std::mem::size_of::<SHFILEINFOW>() as u32,
                flags,
            )
        };
        if ok == 0 || info.hIcon.is_invalid() {
            return None;
        }
        let rgba = unsafe { draw_icon(info.hIcon) };
        let _ = unsafe { DestroyIcon(info.hIcon) };
        let rgba = rgba?;
        encode_png(&rgba)
    }

    /// 把 HICON 画进 32bpp 自上而下 DIB，再按 BGRA → RGBA 读出像素。
    unsafe fn draw_icon(hicon: HICON) -> Option<Vec<u8>> {
        let screen = GetDC(None);
        if screen.is_invalid() {
            return None;
        }
        let mem = CreateCompatibleDC(Some(screen));
        if mem.is_invalid() {
            let _ = ReleaseDC(None, screen);
            return None;
        }

        let mut info = BITMAPINFO::default();
        info.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        info.bmiHeader.biWidth = SIZE;
        // 负高度 = 自上而下，行序与 PNG 一致
        info.bmiHeader.biHeight = -SIZE;
        info.bmiHeader.biPlanes = 1;
        info.bmiHeader.biBitCount = 32;
        info.bmiHeader.biCompression = BI_RGB.0;

        let mut bits: *mut c_void = std::ptr::null_mut();
        let bitmap = match CreateDIBSection(Some(mem), &info, DIB_RGB_COLORS, &mut bits, None, 0) {
            Ok(bitmap) => bitmap,
            Err(_) => {
                let _ = DeleteDC(mem);
                let _ = ReleaseDC(None, screen);
                return None;
            }
        };

        let old = SelectObject(mem, HGDIOBJ(bitmap.0));
        let drawn = DrawIconEx(mem, 0, 0, hicon, SIZE, SIZE, 0, None, DI_NORMAL).is_ok();
        SelectObject(mem, old);

        let mut rgba = vec![0u8; (SIZE * SIZE * 4) as usize];
        if drawn && !bits.is_null() {
            let src = std::slice::from_raw_parts(bits as *const u8, rgba.len());
            for i in 0..(SIZE * SIZE) as usize {
                let b = src[i * 4];
                let g = src[i * 4 + 1];
                let r = src[i * 4 + 2];
                let a = src[i * 4 + 3];
                // GDI 不写 alpha：有颜色但 alpha 为 0 时按不透明处理
                let alpha = if a == 0 && (r | g | b) != 0 { 255 } else { a };
                rgba[i * 4] = r;
                rgba[i * 4 + 1] = g;
                rgba[i * 4 + 2] = b;
                rgba[i * 4 + 3] = alpha;
            }
        }

        let _ = DeleteObject(HGDIOBJ(bitmap.0));
        let _ = DeleteDC(mem);
        let _ = ReleaseDC(None, screen);

        drawn.then_some(rgba)
    }

    fn encode_png(rgba: &[u8]) -> Option<String> {
        let mut out = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut out, SIZE as u32, SIZE as u32);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().ok()?;
            writer.write_image_data(rgba).ok()?;
            writer.finish().ok()?;
        }
        Some(base64::engine::general_purpose::STANDARD.encode(&out))
    }
}
