import re


def normalize_text(raw_text: str, file_ext: str = "") -> str:
    normalized = (
        str(raw_text or "")
        .replace("\r\n", "\n")
        .replace("\f", "\n")
        .replace("\x00", "")
    )
    normalized = "\n".join(line.rstrip() for line in normalized.split("\n"))
    normalized = re.sub(r"\n{3,}", "\n\n", normalized)
    if str(file_ext or "").lower() == "md":
        normalized = re.sub(r"^(#{1,6})([^\s#])", r"\1 \2", normalized, flags=re.MULTILINE)
    return normalized.strip()

