"""WAV file input/output. Live capture (sounddevice) lands in capture/ next."""

from __future__ import annotations

import numpy as np
from scipy.io import wavfile


def read_wav(path: str, channel: int = 0) -> tuple[np.ndarray, int]:
    sr, data = wavfile.read(path)
    if data.ndim > 1:
        if channel >= data.shape[1]:
            raise ValueError(f"{path} has {data.shape[1]} channel(s); channel {channel} does not exist")
        data = data[:, channel]
    if np.issubdtype(data.dtype, np.integer):
        data = data.astype(np.float64) / np.iinfo(data.dtype).max
    return data.astype(np.float64), int(sr)


def write_wav(path: str, data: np.ndarray, sr: int) -> None:
    pcm = np.clip(data, -1.0, 1.0)
    wavfile.write(path, sr, (pcm * 32767).astype(np.int16))
