# Who says each word (src/services/dub/dub.py assign_speakers / by_pitch) on made-up conversations with known answers:
# voice prints and pitches are given, the diarization is deliberately wrong. Run by tests/unit/dub.test.js with the
# dub runtime's Python (skipped when it is not set up).
import os
import sys
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "src", "services", "dub"))
import dub  # noqa: E402

MAN, WOMAN, MAN2 = np.eye(8)[0], np.eye(8)[1], np.eye(8)[2]


class FakePrints:
    """Voice prints and femaleness by who really speaks at a time (truth: [(t0, t1, who)])."""

    def __init__(self, truth):
        self.truth, self.a16 = truth, np.zeros(16000 * 60, dtype=np.float32)

    def who(self, t0, t1):
        share = {}
        for a, b, w in self.truth:
            share[w] = share.get(w, 0) + max(0.0, min(b, t1) - max(a, t0))
        return share

    def embed(self, t0, t1):
        sh = self.who(t0, t1)
        v = sum(({"m": MAN, "w": WOMAN, "m2": MAN2}[k] * s for k, s in sh.items()), np.zeros(8)) + 0.05
        return v / np.linalg.norm(v)

    def female(self, t0, t1):
        sh = self.who(t0, t1)
        return sh.get("w", 0) / max(1e-9, sum(sh.values()))


def conversation(script):
    """script: [(who, n words)] said back to back, words 0.3 s with 0.05 s between, 0.2 s between turns."""
    words, truth, t = [], [], 0.0
    for who, n in script:
        t0 = t
        for _ in range(n):
            words.append({"word": who, "start": t, "end": t + 0.3, "who": who})
            t += 0.35
        truth.append((t0, t, who))
        t += 0.2
    return words, truth


def run(script, turns, pitch):
    words, truth = conversation(script)
    dub.word_pitch = lambda a16, w: np.log(pitch[w["who"]])  # the pitch of each word, by who says it
    by, _ = dub.assign_speakers(words, turns, FakePrints(truth))
    return words


def test_quick_replies_between_a_man_and_a_woman():
    # The man and the woman answer each other quickly; the diarization made one "speaker" (0) of the first exchanges
    # and got the rest right (1 = woman, 2 = man).
    script = [("w", 6), ("m", 3), ("w", 5), ("m", 4), ("w", 2), ("m", 8), ("w", 9), ("m", 10), ("w", 7), ("m", 9)]
    words, truth = conversation(script)
    t_mix = truth[4][1]
    turns = [(0.0, t_mix, 0)] + [(a, b, 1 if w == "w" else 2) for a, b, w in truth[5:]]
    out = run(script, turns, {"m": 150.0, "w": 380.0})
    assert len({w["spk"] for w in out}) == 2, "two speakers: the mixed one is gone"
    woman = max({w["spk"] for w in out if w["who"] == "w"}, key=lambda s: sum(1 for w in out if w["spk"] == s and w["who"] == "w"))
    wrong = sum(1 for w in out if (w["spk"] == woman) != (w["who"] == "w"))
    assert wrong == 0, f"{wrong} words given to the wrong person"


def test_two_men_of_the_same_pitch_keep_the_diarization():
    # Two men, the same pitch: pitch cannot tell them apart and nothing is moved by it; the voice prints keep them two.
    script = [("m", 12), ("m2", 10), ("m", 9), ("m2", 11)]
    words, truth = conversation(script)
    turns = [(a, b, 0 if w == "m" else 1) for a, b, w in truth]
    out = run(script, turns, {"m": 140.0, "m2": 145.0})
    assert all((w["spk"] == 0) == (w["who"] == "m") for w in out)


def test_one_person_split_in_two_is_one_again():
    # The diarization split the same man in two "speakers" (a change of distance to the microphone): one again.
    script = [("m", 14), ("m", 12), ("w", 10), ("m", 9)]
    words, truth = conversation(script)
    turns = [(truth[0][0], truth[0][1], 0), (truth[1][0], truth[1][1], 3), (truth[2][0], truth[2][1], 1), (truth[3][0], truth[3][1], 3)]
    out = run(script, turns, {"m": 150.0, "w": 370.0})
    men = {w["spk"] for w in out if w["who"] == "m"}
    assert len(men) == 1, f"the man is still {men}"
    assert all(w["spk"] != list(men)[0] for w in out if w["who"] == "w")


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
