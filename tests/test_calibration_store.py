"""Measuring must be blocked until a device is calibrated."""

import pytest

from opentimegrapher import cli
from opentimegrapher.session import calibration_store as store


@pytest.fixture(autouse=True)
def isolated_home(tmp_path, monkeypatch):
    monkeypatch.setenv("OTG_HOME", str(tmp_path))


def test_require_blocks_without_calibration():
    with pytest.raises(store.CalibrationRequired):
        store.require("usb-card", 48_000)


def test_calibration_is_per_device_and_sample_rate():
    store.save("usb-card", 48_000, "quartz", -12.5)
    assert store.require("usb-card", 48_000).ppm == -12.5
    with pytest.raises(store.CalibrationRequired):
        store.require("usb-card", 96_000)
    with pytest.raises(store.CalibrationRequired):
        store.require("other-card", 48_000)


def test_cli_analyze_refuses_uncalibrated(tmp_path):
    wav = str(tmp_path / "w.wav")
    cli.main(["synth", "watch", wav, "--duration", "10"])
    assert cli.main(["analyze", wav, "--device", "nope"]) == 3


def test_cli_full_flow(tmp_path, capsys):
    ref = str(tmp_path / "q.wav")
    wav = str(tmp_path / "w.wav")
    cli.main(["synth", "quartz", ref, "--duration", "660", "--clock-ppm", "50"])
    cli.main(["synth", "watch", wav, "--duration", "20", "--rate", "3", "--clock-ppm", "50"])
    assert cli.main(["calibrate", ref, "--device", "bench"]) == 0
    assert cli.main(["analyze", wav, "--device", "bench"]) == 0
    assert "rate +3.0 s/d" in capsys.readouterr().out
