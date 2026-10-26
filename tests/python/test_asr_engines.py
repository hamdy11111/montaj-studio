# The pure helpers of bench/asr_engines.py: splitting a clip longer than a model accepts at its quietest points, and
# cleaning the special tags some models leave in their text. Run by tests/unit/asrAb.test.js with the bundled Python.
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "bench"))
from asr_engines import join_texts, plan_chunks, rms_frames, strip_tags  # noqa: E402


def loud(n):
    return [1.0] * n


def test_short_clip_is_one_piece():
    assert plan_chunks(loud(1200), max_s=30) == [(0.0, 12.0)]
    assert plan_chunks(loud(3000), max_s=30) == [(0.0, 30.0)]


def test_cut_at_the_pause():
    e = loud(5000)                      # 50 s of speech with one pause at 22 s
    for i in range(2200, 2210):
        e[i] = 0.0
    pieces = plan_chunks(e, max_s=30)
    assert pieces[0] == (0.0, 22.09)    # the later frame of the pause: the pause stays whole in the first piece
    assert pieces[-1][1] == 50.0
    assert all(b - a <= 30 for a, b in pieces)
    assert all(p[1] == q[0] for p, q in zip(pieces, pieces[1:])), "no gap, no overlap"


def test_no_pause_still_fits():
    pieces = plan_chunks(loud(9000), max_s=30)   # 90 s without a pause: cut anyway, every piece ≤ 30 s
    assert pieces[0][0] == 0.0 and pieces[-1][1] == 90.0
    assert all(b - a <= 30 for a, b in pieces)
    assert len(pieces) == 3


def test_pause_in_first_half_is_not_used():
    e = loud(4000)
    e[500] = 0.0                        # a pause at 5 s would make a tiny piece: only the second half is searched
    e[2500] = 0.1
    assert plan_chunks(e, max_s=30)[0] == (0.0, 25.0)


def test_rms_frames():
    assert rms_frames([0.0] * 320) == [0.0, 0.0]
    assert abs(rms_frames([0.5] * 160)[0] - 0.5) < 1e-9
    assert len(rms_frames([0.1] * 170)) == 2


def test_tags_removed():
    assert strip_tags("<|ar|> صباح الخير <|endoftext|>") == "صباح الخير"
    assert strip_tags("language Arabic<asr_text>ازيك") == "language Arabic ازيك"
    assert strip_tags("[no speech]") == ""
    assert strip_tags("قابلت [غير مفهوم] كده") == "قابلت [غير مفهوم] كده", "the user's own tags are not model tags"
    assert join_texts(["اول حتة ", None, "<|ar|>تاني حتة"]) == "اول حتة تاني حتة"


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
    print(f"{len(tests)} passed")
