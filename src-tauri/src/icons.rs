//! Item icons read from the user's own Raft install. No game art ships with the editor.
//!
//! `items.json` names each item's Sprite (asset file, object id, name). This module opens the
//! Unity serialized file, reads the Sprite and its Texture2D, decodes only the texture rows the
//! sprite covers from the `.resS` stream, and returns a small PNG.
//!
//! Layouts are for Unity 2021.3 (serialized file version 22), which Raft uses. Other versions are
//! rejected so a game update can only remove icons, never show wrong ones.

use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

const CLASS_TEXTURE2D: i32 = 28;
const CLASS_SPRITE: i32 = 213;
/// Longest side of a served icon, in pixels.
pub const ICON_SIZE: u32 = 64;

// ---------- Little-endian reader over a byte slice ----------

struct Cursor<'a> {
    b: &'a [u8],
    pos: usize,
}

impl<'a> Cursor<'a> {
    fn new(b: &'a [u8]) -> Self {
        Self { b, pos: 0 }
    }
    fn take(&mut self, n: usize) -> Result<&'a [u8], String> {
        let end = self.pos.checked_add(n).filter(|&e| e <= self.b.len()).ok_or("Unexpected end of data")?;
        let s = &self.b[self.pos..end];
        self.pos = end;
        Ok(s)
    }
    fn u8(&mut self) -> Result<u8, String> {
        Ok(self.take(1)?[0])
    }
    fn i16(&mut self) -> Result<i16, String> {
        Ok(i16::from_le_bytes(self.take(2)?.try_into().unwrap()))
    }
    fn i32(&mut self) -> Result<i32, String> {
        Ok(i32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn u32(&mut self) -> Result<u32, String> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn i64(&mut self) -> Result<i64, String> {
        Ok(i64::from_le_bytes(self.take(8)?.try_into().unwrap()))
    }
    fn u64(&mut self) -> Result<u64, String> {
        Ok(u64::from_le_bytes(self.take(8)?.try_into().unwrap()))
    }
    fn f32(&mut self) -> Result<f32, String> {
        Ok(f32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn align4(&mut self) {
        self.pos = (self.pos + 3) & !3;
    }
    fn len(&mut self) -> Result<usize, String> {
        let n = self.i32()?;
        usize::try_from(n).map_err(|_| format!("Negative length {n}"))
    }
    /// Length-prefixed string followed by 4-byte alignment.
    fn string(&mut self) -> Result<String, String> {
        let n = self.len()?;
        let s = String::from_utf8_lossy(self.take(n)?).into_owned();
        self.align4();
        Ok(s)
    }
    fn cstring(&mut self) -> Result<String, String> {
        let rest = &self.b[self.pos..];
        let n = rest.iter().position(|&c| c == 0).ok_or("Unterminated string")?;
        self.pos += n + 1;
        Ok(String::from_utf8_lossy(&rest[..n]).into_owned())
    }
    /// Skip `count` elements of `size` bytes, with the count prefix.
    fn skip_array(&mut self, size: usize) -> Result<(), String> {
        let n = self.len()?;
        self.take(n.checked_mul(size).ok_or("Array too large")?)?;
        Ok(())
    }
    fn pptr(&mut self) -> Result<(i32, i64), String> {
        Ok((self.i32()?, self.i64()?))
    }
    fn rect(&mut self) -> Result<[f32; 4], String> {
        Ok([self.f32()?, self.f32()?, self.f32()?, self.f32()?])
    }
}

// ---------- Serialized file (.assets) ----------

struct ObjectInfo {
    start: u64,
    size: u32,
    class_id: i32,
}

struct AssetsFile {
    path: PathBuf,
    objects: HashMap<i64, ObjectInfo>,
    /// File names of external references. PPtr file id `n` points to `externals[n - 1]`.
    externals: Vec<String>,
    /// Sprite name to object id, built on first lookup by name.
    sprite_names: Mutex<Option<HashMap<String, i64>>>,
}

impl AssetsFile {
    fn open(path: &Path) -> Result<Self, String> {
        let mut f = File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
        let mut head = [0u8; 48];
        f.read_exact(&mut head).map_err(|e| e.to_string())?;
        let be32 = |o: usize| u32::from_be_bytes(head[o..o + 4].try_into().unwrap());
        let be64 = |o: usize| u64::from_be_bytes(head[o..o + 8].try_into().unwrap());
        let version = be32(8);
        if version != 22 {
            return Err(format!("Unsupported asset file version {version}"));
        }
        if head[16] != 0 {
            return Err("Big-endian asset files are not supported".into());
        }
        let metadata_size = be32(20) as usize;
        let data_offset = be64(32);

        let mut meta = vec![0u8; metadata_size];
        f.read_exact(&mut meta).map_err(|e| e.to_string())?;
        // The metadata starts at offset 48, a multiple of 4, so alignment inside it matches the file.
        let mut c = Cursor::new(&meta);
        let unity = c.cstring()?;
        if !unity.starts_with("2021.3.") {
            return Err(format!("Unsupported Unity version {unity}"));
        }
        c.i32()?; // target platform
        if c.u8()? != 0 {
            return Err("Asset files with type trees are not supported".into());
        }
        let mut class_ids = Vec::new();
        for _ in 0..c.len()? {
            let class_id = c.i32()?;
            c.u8()?; // is stripped
            c.i16()?; // script type index
            if class_id == 114 {
                c.take(16)?; // script id
            }
            c.take(16)?; // old type hash
            class_ids.push(class_id);
        }
        let mut objects = HashMap::new();
        for _ in 0..c.len()? {
            c.align4();
            let path_id = c.i64()?;
            let start = c.u64()? + data_offset;
            let size = c.u32()?;
            let type_index = c.len()?;
            let class_id = *class_ids.get(type_index).ok_or("Bad type index")?;
            objects.insert(path_id, ObjectInfo { start, size, class_id });
        }
        for _ in 0..c.len()? {
            c.i32()?;
            c.align4();
            c.i64()?;
        }
        let mut externals = Vec::new();
        for _ in 0..c.len()? {
            c.cstring()?; // temp empty
            c.take(20)?; // guid, type
            let p = c.cstring()?;
            externals.push(p.rsplit(['/', '\\']).next().unwrap_or(&p).to_string());
        }
        Ok(Self { path: path.to_path_buf(), objects, externals, sprite_names: Mutex::new(None) })
    }

    fn read(&self, path_id: i64, class_id: i32) -> Result<Vec<u8>, String> {
        let o = self.objects.get(&path_id).ok_or(format!("Object {path_id} not found"))?;
        if o.class_id != class_id {
            return Err(format!("Object {path_id} has class {} not {class_id}", o.class_id));
        }
        read_at(&self.path, o.start, o.size as usize)
    }

    /// Object id of the Sprite with this name.
    fn sprite_by_name(&self, name: &str) -> Option<i64> {
        let mut names = self.sprite_names.lock().unwrap();
        let map = names.get_or_insert_with(|| {
            let mut map = HashMap::new();
            let Ok(mut f) = File::open(&self.path) else { return map };
            for (&id, o) in &self.objects {
                if o.class_id != CLASS_SPRITE || o.size < 4 {
                    continue;
                }
                // m_Name is the first field. Read only its prefix.
                let mut buf = vec![0u8; (o.size as usize).min(260)];
                if f.seek(SeekFrom::Start(o.start)).is_ok() && f.read_exact(&mut buf).is_ok() {
                    if let Ok(n) = Cursor::new(&buf).string() {
                        map.insert(n, id);
                    }
                }
            }
            map
        });
        map.get(name).copied()
    }
}

fn read_at(path: &Path, offset: u64, len: usize) -> Result<Vec<u8>, String> {
    let mut f = File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    f.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; len];
    f.read_exact(&mut buf).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(buf)
}

// ---------- Sprite and Texture2D ----------

struct Sprite {
    name: String,
    texture: (i32, i64),
    /// x, y, width, height in texture pixels, y measured from the bottom.
    texture_rect: [f32; 4],
}

fn parse_sprite(b: &[u8]) -> Result<Sprite, String> {
    let mut c = Cursor::new(b);
    let name = c.string()?;
    c.rect()?; // m_Rect
    c.take(8 + 16 + 4 + 8 + 4)?; // m_Offset, m_Border, m_PixelsToUnits, m_Pivot, m_Extrude
    c.u8()?; // m_IsPolygon
    c.align4();
    c.take(24)?; // m_RenderDataKey
    for _ in 0..c.len()? {
        c.string()?; // m_AtlasTags
    }
    let atlas = c.pptr()?;
    if atlas.1 != 0 {
        return Err("Sprite atlases are not supported".into());
    }
    // m_RD
    let texture = c.pptr()?;
    c.pptr()?; // alphaTexture
    for _ in 0..c.len()? {
        c.pptr()?;
        c.string()?; // secondaryTextures
    }
    c.skip_array(48)?; // m_SubMeshes
    c.skip_array(1)?; // m_IndexBuffer
    c.align4();
    c.u32()?; // m_VertexCount
    c.skip_array(4)?; // m_Channels
    c.skip_array(1)?; // m_DataSize
    c.align4();
    c.skip_array(64)?; // m_Bindpose
    let texture_rect = c.rect()?;
    Ok(Sprite { name, texture, texture_rect })
}

struct Texture {
    width: u32,
    height: u32,
    format: i32,
    inline: Vec<u8>,
    stream_offset: u64,
    stream_size: u32,
    stream_path: String,
}

fn parse_texture(b: &[u8]) -> Result<Texture, String> {
    let mut c = Cursor::new(b);
    c.string()?; // m_Name
    c.i32()?; // m_ForcedFallbackFormat
    c.take(2)?; // m_DownscaleFallback, m_IsAlphaChannelOptional
    c.align4();
    let width = c.u32()?;
    let height = c.u32()?;
    c.u32()?; // m_CompleteImageSize
    c.i32()?; // m_MipsStripped
    let format = c.i32()?;
    c.i32()?; // m_MipCount
    c.take(4)?; // four bools
    c.align4();
    c.take(4 + 4 + 4 + 24 + 4 + 4)?; // priority, image count, dimension, settings, lightmap format, color space
    c.skip_array(1)?; // m_PlatformBlob
    c.align4();
    let n = c.len()?;
    let inline = c.take(n)?.to_vec();
    c.align4();
    let stream_offset = c.u64()?;
    let stream_size = c.u32()?;
    let stream_path = c.string()?;
    Ok(Texture { width, height, format, inline, stream_offset, stream_size, stream_path })
}

// ---------- Pixel decoding ----------

const FMT_RGB24: i32 = 3;
const FMT_RGBA32: i32 = 4;
const FMT_ARGB32: i32 = 5;
const FMT_DXT1: i32 = 10;
const FMT_DXT5: i32 = 12;

/// Bytes per row of pixels (or per row of 4x4 blocks for DXT) and pixel rows per stored row.
fn row_layout(format: i32, width: u32) -> Option<(usize, u32)> {
    let w = width as usize;
    let blocks = w.div_ceil(4);
    Some(match format {
        FMT_RGB24 => (w * 3, 1),
        FMT_RGBA32 | FMT_ARGB32 => (w * 4, 1),
        FMT_DXT1 => (blocks * 8, 4),
        FMT_DXT5 => (blocks * 16, 4),
        _ => return None,
    })
}

fn rgb565(c: u16) -> [u8; 3] {
    let r = ((c >> 11) & 31) as u32;
    let g = ((c >> 5) & 63) as u32;
    let b = (c & 31) as u32;
    [((r * 255 + 15) / 31) as u8, ((g * 255 + 31) / 63) as u8, ((b * 255 + 15) / 31) as u8]
}

/// Decode a BC1 color block into 16 RGBA pixels, row-major. `four` forces 4-color mode (BC3).
fn decode_color_block(b: &[u8], four: bool, out: &mut [[u8; 4]; 16]) {
    let c0 = u16::from_le_bytes([b[0], b[1]]);
    let c1 = u16::from_le_bytes([b[2], b[3]]);
    let (p0, p1) = (rgb565(c0), rgb565(c1));
    let mix = |a: u8, b: u8, wa: u32, wb: u32, d: u32| ((a as u32 * wa + b as u32 * wb) / d) as u8;
    let mut pal = [[0u8; 4]; 4];
    pal[0] = [p0[0], p0[1], p0[2], 255];
    pal[1] = [p1[0], p1[1], p1[2], 255];
    if four || c0 > c1 {
        for i in 0..3 {
            pal[2][i] = mix(p0[i], p1[i], 2, 1, 3);
            pal[3][i] = mix(p0[i], p1[i], 1, 2, 3);
        }
        pal[2][3] = 255;
        pal[3][3] = 255;
    } else {
        for i in 0..3 {
            pal[2][i] = mix(p0[i], p1[i], 1, 1, 2);
        }
        pal[2][3] = 255;
        pal[3] = [0, 0, 0, 0];
    }
    let idx = u32::from_le_bytes([b[4], b[5], b[6], b[7]]);
    for (i, px) in out.iter_mut().enumerate() {
        *px = pal[((idx >> (2 * i)) & 3) as usize];
    }
}

fn decode_alpha_block(b: &[u8], out: &mut [[u8; 4]; 16]) {
    let (a0, a1) = (b[0] as u32, b[1] as u32);
    let mut pal = [0u8; 8];
    pal[0] = a0 as u8;
    pal[1] = a1 as u8;
    if a0 > a1 {
        for i in 1..7u32 {
            pal[i as usize + 1] = (((7 - i) * a0 + i * a1) / 7) as u8;
        }
    } else {
        for i in 1..5u32 {
            pal[i as usize + 1] = (((5 - i) * a0 + i * a1) / 5) as u8;
        }
        pal[6] = 0;
        pal[7] = 255;
    }
    let mut bits = 0u64;
    for (i, &v) in b[2..8].iter().enumerate() {
        bits |= (v as u64) << (8 * i);
    }
    for (i, px) in out.iter_mut().enumerate() {
        px[3] = pal[((bits >> (3 * i)) & 7) as usize];
    }
}

/// RGBA pixels of rows `y0..y1` (bottom-up order), columns `x0..x1`.
/// `rows` holds the stored rows starting at the one containing `y0`.
fn decode_region(format: i32, width: u32, rows: &[u8], y0: u32, y1: u32, x0: u32, x1: u32) -> Result<Vec<u8>, String> {
    let (stride, per_row) = row_layout(format, width).ok_or(format!("Unsupported texture format {format}"))?;
    let (w, h) = ((x1 - x0) as usize, (y1 - y0) as usize);
    let mut out = vec![0u8; w * h * 4];
    let base_row = y0 / per_row;
    match format {
        FMT_RGB24 | FMT_RGBA32 | FMT_ARGB32 => {
            let bpp = if format == FMT_RGB24 { 3 } else { 4 };
            for y in 0..h {
                let row = &rows[y * stride..(y + 1) * stride];
                for x in 0..w {
                    let p = &row[(x0 as usize + x) * bpp..][..bpp];
                    let px = match format {
                        FMT_RGB24 => [p[0], p[1], p[2], 255],
                        FMT_RGBA32 => [p[0], p[1], p[2], p[3]],
                        _ => [p[1], p[2], p[3], p[0]],
                    };
                    out[(y * w + x) * 4..][..4].copy_from_slice(&px);
                }
            }
        }
        _ => {
            let block_size = if format == FMT_DXT5 { 16 } else { 8 };
            let mut px = [[0u8; 4]; 16];
            for by in (y0 / 4)..y1.div_ceil(4) {
                let row = &rows[(by - base_row) as usize * stride..][..stride];
                for bx in (x0 / 4)..x1.div_ceil(4) {
                    let blk = &row[bx as usize * block_size..][..block_size];
                    if format == FMT_DXT5 {
                        decode_color_block(&blk[8..], true, &mut px);
                        decode_alpha_block(blk, &mut px);
                    } else {
                        decode_color_block(blk, false, &mut px);
                    }
                    for (i, p) in px.iter().enumerate() {
                        let (x, y) = (bx * 4 + i as u32 % 4, by * 4 + i as u32 / 4);
                        if x >= x0 && x < x1 && y >= y0 && y < y1 {
                            let o = (((y - y0) as usize) * w + (x - x0) as usize) * 4;
                            out[o..o + 4].copy_from_slice(p);
                        }
                    }
                }
            }
        }
    }
    Ok(out)
}

/// Shrink to fit `max` x `max` by averaging pixels, weighted by alpha so edges keep their color.
fn downscale(rgba: &[u8], w: u32, h: u32, max: u32) -> (Vec<u8>, u32, u32) {
    if w <= max && h <= max {
        return (rgba.to_vec(), w, h);
    }
    let scale = max as f64 / w.max(h) as f64;
    let (nw, nh) = (((w as f64 * scale).round() as u32).max(1), ((h as f64 * scale).round() as u32).max(1));
    let mut out = vec![0u8; (nw * nh * 4) as usize];
    for ny in 0..nh {
        let (sy0, sy1) = (ny * h / nh, ((ny + 1) * h / nh).max(ny * h / nh + 1));
        for nx in 0..nw {
            let (sx0, sx1) = (nx * w / nw, ((nx + 1) * w / nw).max(nx * w / nw + 1));
            let mut acc = [0f64; 4];
            let mut n = 0f64;
            for y in sy0..sy1 {
                for x in sx0..sx1 {
                    let p = &rgba[((y * w + x) * 4) as usize..][..4];
                    let a = p[3] as f64;
                    acc[0] += p[0] as f64 * a;
                    acc[1] += p[1] as f64 * a;
                    acc[2] += p[2] as f64 * a;
                    acc[3] += a;
                    n += 1.0;
                }
            }
            let o = ((ny * nw + nx) * 4) as usize;
            if acc[3] > 0.0 {
                for i in 0..3 {
                    out[o + i] = (acc[i] / acc[3]).round() as u8;
                }
            }
            out[o + 3] = (acc[3] / n).round() as u8;
        }
    }
    (out, nw, nh)
}

fn encode_png(rgba: &[u8], w: u32, h: u32) -> Result<Vec<u8>, String> {
    let mut buf = Vec::new();
    let mut enc = png::Encoder::new(&mut buf, w, h);
    enc.set_color(png::ColorType::Rgba);
    enc.set_depth(png::BitDepth::Eight);
    let mut wr = enc.write_header().map_err(|e| e.to_string())?;
    wr.write_image_data(rgba).map_err(|e| e.to_string())?;
    wr.finish().map_err(|e| e.to_string())?;
    Ok(buf)
}

// ---------- Store ----------

/// Opened asset files and finished icons for one Raft install.
pub struct IconStore {
    data_dir: Mutex<Option<PathBuf>>,
    files: Mutex<HashMap<String, Arc<AssetsFile>>>,
    icons: Mutex<HashMap<(String, i64), Arc<Vec<u8>>>>,
}

impl IconStore {
    pub fn new(data_dir: Option<PathBuf>) -> Self {
        Self { data_dir: Mutex::new(data_dir), files: Mutex::default(), icons: Mutex::default() }
    }

    pub fn data_dir(&self) -> Option<PathBuf> {
        self.data_dir.lock().unwrap().clone()
    }

    pub fn set_data_dir(&self, dir: Option<PathBuf>) {
        *self.data_dir.lock().unwrap() = dir;
        self.files.lock().unwrap().clear();
        self.icons.lock().unwrap().clear();
    }

    fn file(&self, name: &str) -> Result<Arc<AssetsFile>, String> {
        if name.contains(['/', '\\']) || name.starts_with('.') {
            return Err(format!("Bad asset file name {name}"));
        }
        if let Some(f) = self.files.lock().unwrap().get(name) {
            return Ok(f.clone());
        }
        let dir = self.data_dir().ok_or("Raft install not found")?;
        let f = Arc::new(AssetsFile::open(&dir.join(name))?);
        self.files.lock().unwrap().insert(name.to_string(), f.clone());
        Ok(f)
    }

    /// PNG for the sprite `id` in asset file `file`. When the id does not hold a Sprite named
    /// `name` (the game was updated), the Sprite is looked up by name instead.
    pub fn icon_png(&self, file: &str, id: i64, name: &str) -> Result<Arc<Vec<u8>>, String> {
        let key = (file.to_string(), id);
        if let Some(png) = self.icons.lock().unwrap().get(&key) {
            return Ok(png.clone());
        }
        let (rgba, w, h) = self.sprite_rgba(file, id, name)?;
        let (small, sw, sh) = downscale(&rgba, w, h, ICON_SIZE);
        let png = Arc::new(encode_png(&small, sw, sh)?);
        self.icons.lock().unwrap().insert(key, png.clone());
        Ok(png)
    }

    /// Full-size sprite pixels, top-down RGBA.
    pub fn sprite_rgba(&self, file: &str, id: i64, name: &str) -> Result<(Vec<u8>, u32, u32), String> {
        let af = self.file(file)?;
        let mut sprite = af.read(id, CLASS_SPRITE).and_then(|b| parse_sprite(&b));
        if !matches!(&sprite, Ok(s) if s.name == name) {
            let id = af.sprite_by_name(name).ok_or(format!("Sprite {name} not found"))?;
            sprite = parse_sprite(&af.read(id, CLASS_SPRITE)?);
        }
        let sprite = sprite?;

        let (file_id, tex_id) = sprite.texture;
        let tex_file = if file_id == 0 {
            af.clone()
        } else {
            let ext = af.externals.get(file_id as usize - 1).ok_or("Bad texture reference")?;
            self.file(ext)?
        };
        let tex = parse_texture(&tex_file.read(tex_id, CLASS_TEXTURE2D)?)?;

        let [rx, ry, rw, rh] = sprite.texture_rect;
        let x0 = (rx.round().max(0.0) as u32).min(tex.width);
        let x1 = ((rx + rw).round().max(0.0) as u32).min(tex.width);
        let y0 = (ry.round().max(0.0) as u32).min(tex.height);
        let y1 = ((ry + rh).round().max(0.0) as u32).min(tex.height);
        if x1 <= x0 || y1 <= y0 {
            return Err("Empty sprite".into());
        }

        let (stride, per_row) = row_layout(tex.format, tex.width).ok_or(format!("Unsupported texture format {}", tex.format))?;
        let first = (y0 / per_row) as usize;
        let count = y1.div_ceil(per_row) as usize - first;
        let rows = if tex.stream_size > 0 {
            let dir = self.data_dir().ok_or("Raft install not found")?;
            let res = tex.stream_path.rsplit(['/', '\\']).next().unwrap_or(&tex.stream_path);
            if res.starts_with('.') {
                return Err("Bad resource path".into());
            }
            let needed = (first + count) * stride;
            if needed > tex.stream_size as usize {
                return Err("Texture data is shorter than expected".into());
            }
            read_at(&dir.join(res), tex.stream_offset + (first * stride) as u64, count * stride)?
        } else {
            tex.inline.get(first * stride..(first + count) * stride).ok_or("Texture data is shorter than expected")?.to_vec()
        };

        let bottom_up = decode_region(tex.format, tex.width, &rows, y0, y1, x0, x1)?;
        // Unity stores rows bottom-up. Flip to top-down.
        let (w, h) = (x1 - x0, y1 - y0);
        let row = (w * 4) as usize;
        let mut out = Vec::with_capacity(bottom_up.len());
        for y in (0..h as usize).rev() {
            out.extend_from_slice(&bottom_up[y * row..(y + 1) * row]);
        }
        Ok((out, w, h))
    }
}

/// `Raft_Data` folder for a user-chosen path: the game folder or `Raft_Data` itself.
pub fn data_dir_for(path: &Path) -> Option<PathBuf> {
    [path.join("Raft_Data"), path.to_path_buf()]
        .into_iter()
        .find(|p| p.join("sharedassets0.assets").is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_dxt5_block() {
        // Color: c0 = white, c1 = black, all indices 0 (white). Alpha: a0 = 255, a1 = 0, indices 1 (a1).
        let mut blk = [0u8; 16];
        blk[0] = 255;
        blk[1] = 0;
        // 3-bit indices all set to 1: bit pattern 001 repeated.
        let mut bits = 0u64;
        for i in 0..16 {
            bits |= 1 << (3 * i);
        }
        blk[2..8].copy_from_slice(&bits.to_le_bytes()[..6]);
        blk[8..10].copy_from_slice(&0xFFFFu16.to_le_bytes());
        let px = decode_region(FMT_DXT5, 4, &blk, 0, 4, 0, 4).unwrap();
        assert_eq!(&px[..4], &[255, 255, 255, 0]);
        assert_eq!(px.len(), 64);
    }

    #[test]
    fn downscale_keeps_aspect() {
        let img = vec![255u8; 128 * 32 * 4];
        let (_, w, h) = downscale(&img, 128, 32, 64);
        assert_eq!((w, h), (64, 16));
    }

    /// Writes every item icon at full size to $ICON_DUMP for comparison with UnityPy.
    /// Needs RAFT_DATA (the Raft_Data folder) and ITEMS (items.json).
    #[test]
    #[ignore]
    fn dump_icons() {
        let data = PathBuf::from(std::env::var("RAFT_DATA").unwrap());
        let out = PathBuf::from(std::env::var("ICON_DUMP").unwrap());
        let items: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(std::env::var("ITEMS").unwrap()).unwrap()).unwrap();
        let store = IconStore::new(Some(data));
        let (mut ok, mut failed) = (0, 0);
        for (id, it) in items.as_object().unwrap() {
            let Some(s) = it.get("sprite").filter(|s| !s.is_null()) else { continue };
            match store.sprite_rgba(s["file"].as_str().unwrap(), s["id"].as_i64().unwrap(), s["name"].as_str().unwrap()) {
                Ok((rgba, w, h)) => {
                    std::fs::write(out.join(format!("{id}.png")), encode_png(&rgba, w, h).unwrap()).unwrap();
                    ok += 1;
                }
                Err(e) => {
                    eprintln!("{id}: {e}");
                    failed += 1;
                }
            }
        }
        eprintln!("ok {ok} failed {failed}");
    }
}
