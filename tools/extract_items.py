"""Regenerate src/data/items.json from a local Raft install.

Usage:
  python -m venv .venv && .venv/bin/pip install UnityPy TypeTreeGeneratorAPI
  .venv/bin/python tools/extract_items.py <path to Raft/Raft_Data> src/data/items.json
"""
import glob
import json
import struct
import sys

import UnityPy
from UnityPy.helpers.TypeTreeGenerator import TypeTreeGenerator


def read_i2_english(env) -> dict[str, str]:
    """English text per term from the I2Languages asset.

    Raw layout (I2 Localization LanguageSourceData): the generated type tree
    does not match this build, so the fields are read directly.
    """
    obj = next(o for o in env.objects if o.type.name == 'MonoBehaviour'
               and o.read(check_read=False).m_Name == 'I2Languages')
    b = obj.get_raw_data()
    pos = 0

    def i32() -> int:
        nonlocal pos
        v = struct.unpack_from('<i', b, pos)[0]
        pos += 4
        return v

    def string() -> str:
        nonlocal pos
        n = i32()
        v = b[pos:pos + n].decode('utf-8')
        pos = (pos + n + 3) & ~3
        return v

    def skip_bytes() -> None:
        nonlocal pos
        n = i32()
        pos = (pos + n + 3) & ~3

    pos = 28          # MonoBehaviour header
    string()          # m_Name
    pos += 12         # three aligned bools
    terms = {}
    for _ in range(i32()):
        term = string()
        i32()                                   # TermType
        langs = [string() for _ in range(i32())]
        skip_bytes()                            # Flags
        for _ in range(i32()):                  # Languages_Touch
            string()
        terms[term] = langs
    pos += 4          # CaseInsensitiveTerms
    i32()             # OnMissingTranslation
    string()          # mTerm_AppName
    codes = []
    for _ in range(i32()):
        string()      # Name
        codes.append(string())
        pos += 4      # Flags
    en = codes.index('en')
    return {k: v[en] for k, v in terms.items() if len(v) > en}


def english_name(i2: dict[str, str], term: str | None) -> str | None:
    """Item terms read "Name@Description"."""
    text = i2.get(term or '')
    if not text:
        return None
    return text.split('@', 1)[0].strip() or None


def sprite_ref(obj, pptr) -> dict | None:
    """Asset file, object id and name of an item's inventory sprite. No image data."""
    if not pptr or not pptr.get('m_PathID'):
        return None
    af = obj.assets_file
    if pptr['m_FileID']:
        ext = af.externals[pptr['m_FileID'] - 1]
        af = next(f for f in af.environment.files.values() if f.name.endswith(ext.path.split('/')[-1]))
    sprite = af.objects[pptr['m_PathID']]
    return {'file': af.name.split('/')[-1], 'id': pptr['m_PathID'], 'name': sprite.peek_name()}


def main(data_dir: str, out_path: str) -> None:
    files = [f for f in glob.glob(data_dir.rstrip('/') + '/*')
             if not f.endswith(('.resS', '.resource', '.info', '.config'))]
    env = UnityPy.load(*files)
    version = env.objects[0].assets_file.unity_version
    gen = TypeTreeGenerator(version)
    gen.load_local_dll_folder(data_dir.rstrip('/') + '/Managed')
    node = gen.get_nodes_up('Assembly-CSharp.dll', 'Item_Base')
    i2 = read_i2_english(env)

    out = {}
    for obj in env.objects:
        if obj.type.name != 'MonoBehaviour':
            continue
        raw = obj.get_raw_data()
        # Item_Base starts with m_Name at offset 28. Skip anything that cannot be a short name.
        if len(raw) < 32 or not 0 < struct.unpack_from('<i', raw, 28)[0] < 200:
            continue
        try:
            t = obj.read_typetree(node, check_read=True)
        except Exception:
            continue
        if 'uniqueIndex' not in t or not t.get('uniqueName'):
            continue
        inv = t.get('settings_Inventory', {})
        out[t['uniqueIndex']] = {
            'name': t['uniqueName'],
            # English from the localization table. displayName is a fallback and is sometimes Swedish.
            # Items without a term are internal placeholders. The editor shows their uniqueName.
            'display': english_name(i2, inv.get('localizationTerm'))
            or (inv.get('displayName') if inv.get('localizationTerm') else None),
            'term': inv.get('localizationTerm'),
            'stack': inv.get('stackSize'),
            'uses': t.get('maxUses'),
            # Where the icon lives in the game files. The editor reads the pixels from the user's install.
            'sprite': sprite_ref(obj, inv.get('sprite')),
        }
    with open(out_path, 'w') as f:
        json.dump(dict(sorted(out.items())), f, indent=1)
    print(f'{len(out)} items written to {out_path}')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
