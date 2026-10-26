"""Easy Cover's pure parts (src/services/music/engine/montaj_music/cover_core.py): the section plan, the early-end floor,
the time fit, the join and the checks. Run with the music runtime's Python (numpy):
    runtime/music/Scripts/python.exe tests/python/test_music_cover.py      (or with pytest)
"""
import importlib.util
import os

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("cover_core", os.path.join(HERE, "..", "..", "src", "services", "music", "engine", "montaj_music", "cover_core.py"))
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)


def test_short_part_is_one_section():
    p = core.plan(30.0)
    assert len(p["chunks"]) == 1 and p["chunks"][0]["start"] == 0 and p["chunks"][0]["end"] == 30.0 and p["overlap"] == 0
    assert len(core.plan(130.0)["chunks"]) == 1


def test_long_part_sections_cover_everything_with_overlaps():
    for d in (240.0, 909.68, 1200.0):
        p = core.plan(d)
        c = p["chunks"]
        assert c[0]["start"] == 0 and c[-1]["end"] == d
        for a, b in zip(c, c[1:]):
            assert b["start"] < a["end"], "neighbours overlap"
            assert abs((a["end"] - b["start"]) - core.OVERLAP_SECONDS) < 1e-9
        assert max(x["core_end"] - x["core_start"] for x in c) <= core.CHUNK_SECONDS + 20 + 1e-9
    assert [round(x, 1) for x in core.plan(240.0)["cuts"]] == [0.0, 100.0, 200.0, 240.0]


def test_cut_prefers_a_quiet_point_near_the_target():
    p = core.plan(240.0, valleys=[(95.0, .9), (104.0, .05), (130.0, .0)], beats=[104.02])
    assert p["cuts"][1] == 104.0


def test_plan_refuses_out_of_range():
    for d in (5, 1300, float("nan")):
        try:
            core.plan(d)
            assert False
        except ValueError:
            pass


def test_early_end_floor_is_97_percent_below_the_ceiling():
    assert core.min_frames(100, 106) == round(97 * 25)
    assert core.min_frames(30, 30.5) == round(30 * .97 * 25)
    assert core.min_frames(10, 10) <= 10 * 25 - 1


def test_fit_ratio_refuses_the_source_failure():
    assert core.fit_ratio(179.44, 177.6) is not None
    assert core.fit_ratio(120.56, 183.6) is None  # the source studio's failed section 2
    assert core.fit_ratio(0, 10) is None


def test_assemble_is_exact_and_covers_every_sample():
    sr = 1000
    p = core.plan(240.0)
    t = np.arange(round(240 * sr)) / sr
    full = np.stack([np.sin(2 * np.pi * 3 * t), np.cos(2 * np.pi * 3 * t)], 1).astype(np.float32) * .5
    waves = [full[round(c["start"] * sr):round(c["end"] * sr)] for c in p["chunks"]]
    out, seams = core.assemble(p["chunks"], waves, sr)
    assert out.shape == full.shape and len(seams) == 2
    assert float(np.max(np.abs(out - full))) < 1e-4
    assert not any(s["silence_warning"] for s in seams)


def test_assemble_refuses_a_short_section():
    sr = 1000
    p = core.plan(240.0)
    waves = [np.zeros((round((c["end"] - c["start"]) * sr), 2), np.float32) + .1 for c in p["chunks"]]
    waves[1] = waves[1][:-10]
    try:
        core.assemble(p["chunks"], waves, sr)
        assert False
    except ValueError:
        pass


def test_style_text_has_no_tempo_number_and_marks_inner_sections():
    preset = {"lead": "qanun", "prompt": "Arabic takht.", "variants": {"Classic": {"direction": "classic"}}}
    inner = core.style_text(preset, "Classic", "", 64, (2, 3))
    assert "BPM" not in inner and "No ending cadence" in inner and "No separate introduction" in inner
    first = core.style_text(preset, "Modern", "اهدى شوية", None, (1, 3))
    assert "No separate introduction" not in first and "User direction: اهدى شوية" in first
    assert "Continuous" not in core.style_text(preset, "Classic", "", None, (1, 1))


def test_melody_and_verdict():
    ref = [(i * .5, 60 + (i % 5), .4) for i in range(40)]
    same = core.melody(ref, ref)
    assert same["pitch_class_sequence_ratio"] == 1 and same["matched_register_shift_semitones"] == 0
    assert core.verdict(same, 0, 1.0)["passed"]
    octave = core.verdict(core.melody(ref, [(a, p - 12, d) for a, p, d in ref]), 0, 1.0)
    assert octave["passed"] and "أوكتاف" in " ".join(octave["warnings"])  # the melody, an octave lower: kept
    other_key = core.verdict(core.melody(ref, [(a, p + 7, d) for a, p, d in ref]), 0, 1.0)
    assert not other_key["passed"]  # another key: the pitch classes no longer match
    v = core.verdict(same, 3, None)
    assert not v["passed"] and len(v["failures"]) == 2
    assert not core.melody(ref[:4], ref)["sufficient"]


def test_score_time_follows_the_bar_grid():
    # A singer who slows down: bars of 2.0, 2.0, 2.5, 3.0 s in the song; the score's bars are 2 s each.
    grid = {"source": [0., 2., 4., 6.5, 9.5], "score": [0., 2., 4., 6., 8.]}
    assert core.score_time(grid, 5.25) == 5.0 and core.score_time(grid, 9.5) == 8.0
    assert core.score_time(grid, -1.) == -1.0 and abs(core.score_time(grid, 11.) - 9.0) < 1e-9
    # The take played the 8 s score in 8.8 s: the song's 0..9.5 s is the whole take.
    g0, g1 = core.window(grid, 9.5, 1.0, 8.8, 8.0)
    assert g0 == 0 and abs(g1 - 8.8) < 1e-9
    # A pickup bar padded before the song (score time 0 is 0.5 s before the song starts).
    g0, g1 = core.window({"source": [-0.5, 1.5, 3.5], "score": [0., 2., 4.]}, 3.0, 1.0, 4.0, 4.0)
    assert abs(g0 - 0.5) < 1e-9 and abs(g1 - 3.5) < 1e-9


if __name__ == "__main__":
    n = 0
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            n += 1
    print(f"{n} passed")
