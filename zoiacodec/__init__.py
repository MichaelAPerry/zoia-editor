"""Read and write fixed-size ZOIA patch files."""

import json
import struct
from pathlib import Path

__all__ = ["decode", "encode"]

FILE_SIZE = 32768
NAME_SIZE = 16
MODULE_HEADER = struct.Struct("<8I8s")
MODULE_NAMES = json.loads(
    Path(__file__).with_name("module_index.json").read_text(encoding="utf-8")
)["names"]


def _read_name(raw):
    return raw.split(b"\0", 1)[0].decode("ascii", errors="replace")


def _put_name(record, key, raw):
    name = _read_name(raw)
    record[key] = name
    if name.encode("ascii", errors="replace").ljust(NAME_SIZE, b"\0") != raw:
        record[f"{key}_hex"] = raw.hex()


def _name_bytes(record, key):
    name = record.get(key, "")
    hex_key = f"{key}_hex"
    if hex_key in record:
        raw = bytes.fromhex(record[hex_key])
        if len(raw) != NAME_SIZE:
            raise ValueError(f"{hex_key} must contain 16 bytes")
        if name == _read_name(raw):
            return raw
    raw = name.encode("ascii")
    if len(raw) > NAME_SIZE or b"\0" in raw:
        raise ValueError(f"{key} must be at most 16 ASCII bytes without NUL")
    return raw.ljust(NAME_SIZE, b"\0")


class _Reader:
    def __init__(self, data):
        self.data = data
        self.offset = 0

    def take(self, size):
        end = self.offset + size
        if end > len(self.data):
            raise ValueError(f"Section overruns payload at byte {self.offset + 24}")
        result = self.data[self.offset:end]
        self.offset = end
        return result

    def words(self, count):
        return struct.unpack(f"<{count}I", self.take(4 * count))

    def word(self):
        return self.words(1)[0]


def _decode_module(header, body, has_colors):
    _, type_id, version, page, color, position, count, save_word, options = header
    param_bytes = count * 4
    if param_bytes > len(body) - (NAME_SIZE if has_colors else 0):
        raise ValueError("Module parameter count exceeds record length")
    module = {
        "type_id": type_id,
        "type": MODULE_NAMES.get(str(type_id), f"Unknown module {type_id}"),
        "version": version,
        "page": page,
        "header_color": color,
        "position": position,
        "save_word": save_word,
        "options": list(options),
        "parameters": list(struct.unpack(f"<{count}I", body[:param_bytes])),
    }
    extra = body[param_bytes:]
    end_name = extra[-NAME_SIZE:]
    # The format document proposes a text heuristic for pre-color records.
    legacy_name = (
        len(end_name) == NAME_SIZE
        and all(32 <= byte < 127 for byte in end_name.split(b"\0", 1)[0])
        and end_name.rstrip(b"\0").find(b"\0") == -1
    )
    if has_colors or legacy_name:
        _put_name(module, "name", end_name)
        extra = extra[:-NAME_SIZE]
    else:
        module["name"] = None
    if extra:
        module["saved_data_hex"] = extra.hex()
    return module


def _decode_star(raw):
    connection = bool(raw & 0x80000000)
    value = raw ^ 0xFFFFFFFF if connection else raw
    cc = value >> 23
    block = (value >> 16) & 127
    index = value & 65535
    star = {"midi_cc": cc - 1 if cc else None}
    if connection:
        star.update(connection=index, reserved=block)
    else:
        star.update(module=index, block=block)
    return star


def _decode_body(body, module_count):
    reader = _Reader(body)
    records = []
    for _ in range(module_count):
        header = MODULE_HEADER.unpack(reader.take(MODULE_HEADER.size))
        if header[0] < 10:
            raise ValueError(f"Module {len(records)} has invalid size {header[0]} words")
        records.append((header, reader.take(4 * header[0] - MODULE_HEADER.size)))

    connections = []
    for source, out_block, target, in_block, strength in struct.iter_unpack(
        "<5I", reader.take(20 * reader.word())
    ):
        connections.append({
            "source": [source, out_block],
            "destination": [target, in_block],
            "strength": strength,
        })
    pages = []
    for _ in range(reader.word()):
        page = {}
        _put_name(page, "name", reader.take(NAME_SIZE))
        pages.append(page)
    starred = [_decode_star(raw) for raw in reader.words(reader.word())]

    has_colors = bool(module_count and len(body) - reader.offset >= 4 * module_count)
    colors = list(reader.words(module_count)) if has_colors else []
    patch = {
        "modules": [_decode_module(header, data, has_colors) for header, data in records],
        "connections": connections,
        "pages": pages,
        "starred": starred,
        "colors": colors,
    }
    if reader.offset < len(body):
        patch["payload_tail_hex"] = body[reader.offset:].hex()
    return patch


def decode(data: bytes) -> dict:
    """Decode a file into JSON data, preserving unsupported layouts as opaque bytes."""
    if len(data) != FILE_SIZE:
        raise ValueError("ZOIA patch must be exactly 32768 bytes")
    if not any(data):
        return {"empty": True}  # blank slot: all zero bytes
    size, name, module_count = struct.unpack_from("<I16sI", data)
    end = size * 4
    if not 24 <= end <= FILE_SIZE:
        raise ValueError(f"Invalid patch size {size} words")
    patch = {}
    _put_name(patch, "name", name)
    body = data[24:end]
    try:
        patch.update(_decode_body(body, module_count))
    except ValueError as error:
        patch.update(
            decode_error=str(error), module_count=module_count, opaque_body_hex=body.hex()
        )
    padding = data[end:].rstrip(b"\0")
    if padding:
        patch["padding_hex"] = padding.hex()
    return patch


def _pack_words(*values):
    return struct.pack(f"<{len(values)}I", *values)


def _encode_module(module):
    options = bytes(module.get("options", []))
    if len(options) > 8:
        raise ValueError("A module can have at most eight option bytes")
    parameters = module.get("parameters", [])
    saved = bytes.fromhex(module.get("saved_data_hex", ""))
    if len(saved) % 4:
        raise ValueError("Module saved data must be word-aligned")
    name = b"" if module.get("name", "") is None else _name_bytes(module, "name")
    size = 10 + len(parameters) + (len(saved) + len(name)) // 4
    return MODULE_HEADER.pack(
        size, module["type_id"], module.get("version", 0), module.get("page", 0),
        module.get("header_color", 1), module["position"], len(parameters),
        module.get("save_word", 0), options,
    ) + _pack_words(*parameters) + saved + name


def _encode_star(star):
    is_connection = "connection" in star
    index = star["connection"] if is_connection else star["module"]
    block = star.get("reserved", 0) if is_connection else star["block"]
    midi_cc = star.get("midi_cc")
    cc = 0 if midi_cc is None else midi_cc + 1
    if not (0 <= index <= 65535 and 0 <= block <= 127 and 0 <= cc <= 255):
        raise ValueError("Starred element is out of range")
    value = index | (block << 16) | (cc << 23)
    return value ^ 0xFFFFFFFF if is_connection else value


def _encode_body(patch):
    modules = patch.get("modules", [])
    connections = patch.get("connections", [])
    pages = patch.get("pages", [])
    starred = patch.get("starred", [])
    colors = patch.get("colors", [module.get("header_color", 1) for module in modules])
    if colors and len(colors) != len(modules):
        raise ValueError("Color table must contain one word per module")
    if colors and any(module.get("name", "") is None for module in modules):
        raise ValueError("The color table requires a name field in each module")

    body = bytearray(_pack_words(len(modules)))
    for module in modules:
        body.extend(_encode_module(module))
    body.extend(_pack_words(len(connections)))
    for connection in connections:
        src, out_block = connection["source"]
        dest, in_block = connection["destination"]
        body.extend(_pack_words(src, out_block, dest, in_block, connection["strength"]))
    body.extend(_pack_words(len(pages)))
    for page in pages:
        body.extend(_name_bytes(page, "name"))
    body.extend(_pack_words(len(starred), *map(_encode_star, starred)))
    body.extend(_pack_words(*colors))
    body.extend(bytes.fromhex(patch.get("payload_tail_hex", "")))
    return body


def encode(patch: dict) -> bytes:
    """Encode the JSON representation as exactly 32768 bytes."""
    if patch.get("empty"):
        return bytes(FILE_SIZE)
    try:
        if "opaque_body_hex" in patch:
            body = _pack_words(patch["module_count"]) + bytes.fromhex(patch["opaque_body_hex"])
        else:
            body = _encode_body(patch)
        if len(body) % 4:
            raise ValueError("Patch payload must be word-aligned")
        data = _pack_words((20 + len(body)) // 4) + _name_bytes(patch, "name") + body
        data += bytes.fromhex(patch.get("padding_hex", ""))
        if len(data) > FILE_SIZE:
            raise ValueError("Patch exceeds 32768 bytes")
        return data.ljust(FILE_SIZE, b"\0")
    except struct.error as error:
        raise ValueError(f"Invalid binary field: {error}") from error
