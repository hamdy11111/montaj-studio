"""Still-image background removal with BiRefNet (MIT; the architecture RMBG-2.0 is built on).

  cutout.py --model DIR --out OUT.png [--size 1024] IMAGE
Writes OUT.png (RGBA: the image with the predicted alpha). Prints {"done": true, "seconds", "peakGB"}.
"""
import argparse, json, sys, time


def main():
    p = argparse.ArgumentParser()
    p.add_argument("image"); p.add_argument("--model", required=True); p.add_argument("--out", required=True)
    p.add_argument("--size", type=int, default=1024)
    a = p.parse_args()
    import torch
    from PIL import Image
    from torchvision import transforms
    from transformers import AutoModelForImageSegmentation
    t0 = time.time()
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    m = AutoModelForImageSegmentation.from_pretrained(a.model, trust_remote_code=True).to(dev).eval()
    if dev == "cuda":
        m = m.half(); torch.cuda.reset_peak_memory_stats()
    im = Image.open(a.image).convert("RGB")
    tf = transforms.Compose([transforms.Resize((a.size, a.size)), transforms.ToTensor(), transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225])])
    x = tf(im).unsqueeze(0).to(dev)
    if dev == "cuda":
        x = x.half()
    with torch.no_grad():
        pred = m(x)[-1].sigmoid().float().cpu()[0, 0]
    alpha = transforms.ToPILImage()(pred).resize(im.size, Image.BILINEAR)
    out = im.copy(); out.putalpha(alpha); out.save(a.out)
    peak = torch.cuda.max_memory_allocated() / 2 ** 30 if dev == "cuda" else 0
    sys.stdout.write(json.dumps({"done": True, "seconds": round(time.time() - t0, 2), "peakGB": round(peak, 2)}) + "\n")


if __name__ == "__main__":
    main()
