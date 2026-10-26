// Where every model of the AI layers comes from (perception, best take, links, B-roll index) — the hand-written input
// of buildCatalog.mjs, which resolves each source to a pinned revision, checks it against the files already on this
// PC and writes catalog.json (url, size, SHA-256 per file). Nothing here is read by the app at run time.
//
// A set's `src` entries:
//   { hf: "owner/name", rev, dir, files: [...] | "all" }   Hugging Face, a pinned commit ("main" is resolved once)
//   { gh: "owner/name", ref, dir, files: [[repoPath, localPath]…] }  GitHub, a pinned commit (git LFS files too)
//   { url, dir, file, md5? }                                 a single official file (zenodo, Google's model store)
//   { archive: url, dir, members: [[memberName, localPath]…] }  files unpacked from an official zip / nupkg
//   { derived: "how it was made", dir, file }                  made on this PC from an official source (a converted
//                                                            or exported checkpoint): import only, never downloaded
// `dir` is the folder under runtime/models/<layer root>; `local` overrides where the builder finds today's copy.
export const SOURCES = [
  // ------------------------------------------------------------------ perception («الإدراك», phase 4)
  {
    layer: "perception", root: "perception", sets: [
      { id: "align", name: "wav2vec2 Arabic (word timing)", stages: ["words"], license: "Apache-2.0", gpuGB: 1.5,
        src: [{ hf: "jonatasgrosman/wav2vec2-large-xlsr-53-arabic", rev: "main", dir: "wav2vec2-large-xlsr-53-arabic",
          files: ["config.json", "preprocessor_config.json", "pytorch_model.bin", "special_tokens_map.json", "vocab.json", "README.md"] }] },
      { id: "speakers", name: "pyannote speaker-diarization community-1 (who speaks when)", stages: ["speakers"], license: "CC-BY-4.0", gpuGB: 2,
        gated: { url: "https://huggingface.co/pyannote/speaker-diarization-community-1", why: "gated on Hugging Face: accept its conditions with a Hugging Face login, then import the downloaded folder (or the Hugging Face cache)" },
        src: [{ hf: "pyannote/speaker-diarization-community-1", rev: "main", dir: "pyannote-speaker-diarization-community-1",
          files: ["config.yaml", "embedding/pytorch_model.bin", "plda/plda.npz", "plda/xvec_transform.npz", "segmentation/pytorch_model.bin"] }] },
      { id: "audio", name: "PANNs + laughter detection (sound events, laughs)", stages: ["audio"], license: "PANNs weights CC-BY-4.0, code MIT; laughter-detection MIT", gpuGB: 2.6,
        src: [
          { url: "https://zenodo.org/records/3987831/files/Cnn14_DecisionLevelMax_mAP%3D0.385.pth?download=1", zenodo: { record: 3987831, key: "Cnn14_DecisionLevelMax_mAP=0.385.pth", md5: "70539c43" }, dir: "panns", file: "Cnn14_DecisionLevelMax_mAP=0.385.pth" },
          { gh: "qiuqiangkong/audioset_tagging_cnn", ref: "HEAD", dir: "panns", files: [["metadata/class_labels_indices.csv", "class_labels_indices.csv"]] },
          { gh: "jrgillick/laughter-detection", ref: "HEAD", dir: "laughter-detection",
            files: [["configs.py", "configs.py"], ["models.py", "models.py"], ["LICENSE", "LICENSE"], ["checkpoints/in_use/resnet_with_augmentation/best.pth.tar", "checkpoints/in_use/resnet_with_augmentation/best.pth.tar"]] },
        ] },
      { id: "emotion", name: "emotion2vec+ large (emotion per sentence)", stages: ["emotion"], license: "FunASR model licence v1.1 (attribution)", gpuGB: 1,
        src: [{ hf: "emotion2vec/emotion2vec_plus_large", rev: "main", dir: "emotion2vec_plus_large", files: ["config.yaml", "configuration.json", "model.pt", "README.md", "tokens.txt"] }] },
      { id: "shots", name: "TransNetV2 (shot cuts)", stages: ["shots"], license: "MIT", gpuGB: 0.3,
        src: [
          { gh: "soCzech/TransNetV2", ref: "HEAD", dir: "transnetv2", files: [["inference-pytorch/transnetv2_pytorch.py", "transnetv2_pytorch.py"], ["inference-pytorch/convert_weights.py", "convert_weights.py"], ["LICENSE", "LICENSE"]] },
          { derived: "converted from the official TensorFlow weights (soCzech/TransNetV2, inference/transnetv2-weights) with the authors' convert_weights.py — 100 % output match", dir: "transnetv2", file: "transnetv2-pytorch-weights.pth" },
        ] },
      { id: "faces", name: "InsightFace buffalo_l (faces and who they are)", stages: ["faces"], license: "non-commercial research (personal use)", gpuGB: 2.5,
        src: [{ archive: "https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip", dir: "buffalo_l", members: [["det_10g.onnx", "det_10g.onnx"], ["w600k_r50.onnx", "w600k_r50.onnx"]] }] },
      { id: "adaface", name: "AdaFace IR-101 (faces in poor light)", stages: ["faces"], optional: true, license: "code MIT; weights WebFace terms (non-commercial research)", gpuGB: 0,
        src: [{ derived: "exported to ONNX from huggingface.co/minchul/cvlface_adaface_ir101_webface12m (the authors' repository), max difference 1e-5", dir: "adaface", file: "adaface_ir101_webface12m.onnx" }] },
      { id: "asd", name: "LR-ASD + Light-ASD (who is talking on screen)", stages: ["asd"], license: "MIT", gpuGB: 1,
        src: ["LR-ASD", "Light-ASD"].map((r) => ({ gh: `Junhua-Liao/${r}`, ref: "HEAD", dir: r,
          files: ["ASD.py", "loss.py", "model/Classifier.py", "model/Encoder.py", "model/Model.py", "weight/finetuning_TalkSet.model", "LICENSE"].map((f) => [f, f]) })) },
      { id: "vision", name: "Qwen3.6-35B-A3B (the eye: what happens in each shot)", stages: ["vision"], license: "Apache-2.0", gpuGB: 19,
        src: [{ hf: "unsloth/Qwen3.6-35B-A3B-GGUF", rev: "a483e9e", dir: "qwen3.6-35b-a3b", files: ["Qwen3.6-35B-A3B-UD-IQ4_XS.gguf", "mmproj-F16.gguf"] }] },
      { id: "omni", name: "Qwen3-Omni-30B-A3B (the ear: sees and hears a moment)", stages: ["windowCheck"], optional: true, license: "Apache-2.0", gpuGB: 20,
        src: [{ hf: "ggml-org/Qwen3-Omni-30B-A3B-Instruct-GGUF", rev: "main", dir: "qwen3-omni-30b-a3b", files: ["Qwen3-Omni-30B-A3B-Instruct-Q4_K_M.gguf", "mmproj-Qwen3-Omni-30B-A3B-Instruct-Q8_0.gguf"] }] },
    ],
  },
  // ------------------------------------------------------------------ best take («أحسن إعادة», phase 5)
  {
    layer: "takes", root: "takes", sets: [
      { id: "voice", name: "DNSMOS P.835 (sound quality of a take)", license: "CC-BY-4.0", gpuGB: 0,
        src: [{ gh: "microsoft/DNS-Challenge", ref: "HEAD", dir: "dnsmos", files: [["DNSMOS/DNSMOS/sig_bak_ovr.onnx", "sig_bak_ovr.onnx"], ["LICENSE", "LICENSE"]] }] },
      { id: "face", name: "Face: YuNet, MediaPipe Face Landmarker, LibreFace (smiles, brows, blinks)", license: "YuNet MIT; MediaPipe Apache-2.0; LibreFace USC research licence (non-commercial)", gpuGB: 0.5,
        src: [
          { gh: "opencv/opencv_zoo", ref: "HEAD", dir: "yunet", files: [["models/face_detection_yunet/face_detection_yunet_2023mar.onnx", "face_detection_yunet_2023mar.onnx"], ["models/face_detection_yunet/LICENSE", "LICENSE"]] },
          { url: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task", dir: "mediapipe", file: "face_landmarker.task" },
          { archive: "https://www.nuget.org/api/v2/package/LibreFace/2.0.0", dir: "libreface",
            members: ["LibreFace_AU_Encoder.onnx", "LibreFace_AU_Intensity.onnx", "LibreFace_AU_Presence.onnx", "LibreFace_FE.onnx"].map((f) => [f, f]) },
        ] },
      { id: "gaze", name: "L2CS-Net Gaze360 (looking at the camera)", license: "code MIT; weights Gaze360 terms (non-commercial)", gpuGB: 0.5,
        src: [{ hf: "py-feat/l2cs", rev: "main", dir: "l2cs", files: ["l2cs_gaze360_resnet50.safetensors"] }] },
    ],
  },
  // ------------------------------------------------------------------ B-roll index of the user's footage (phase 9)
  {
    layer: "broll", root: "media", sets: [
      ...[
        ["siglip2", "SigLIP2 so400m (pictures ↔ English)", "google/siglip2-so400m-patch16-naflex", "cc24074f717b612951c2dead130904ab9b65a81e", "Apache-2.0", 2.3],
        ["metaclip2", "MetaCLIP 2 worldwide (pictures ↔ Arabic)", "facebook/metaclip-2-worldwide-huge-quickgelu", "c139061af7b10fdb2e754b60d2b1182a3d5526c2", "CC-BY-NC-4.0", 3.6],
        ["qwen3vlEmb", "Qwen3-VL-Embedding-2B (the shot as a video)", "Qwen/Qwen3-VL-Embedding-2B", "9f2f7e710d6d81056aa5c0a4f04764fec6bb7bda", "Apache-2.0", 7.2],
        ["rerank", "Qwen3-VL-Reranker-2B (re-ranking the top 30)", "Qwen/Qwen3-VL-Reranker-2B", "4bd860ac4f15ad1897a214615cccc700f8f71818", "Apache-2.0", 7.2],
        ["bge", "bge-m3 (searching the captions)", "BAAI/bge-m3", "5617a9f61b028005a4858fdac845db406aefb181", "MIT", 1.2],
      ].map(([id, name, repo, rev, license, gpuGB]) => ({ id, name, license, gpuGB, src: [{ hf: repo, rev, dir: repo.replace("/", "__"), files: "all" }] })),
      // The captions and the search expansion: the dubbing translator (Qwen3.5-35B-A3B Q4_K_M, installed by the dubbing
      // set-up) sees through this projector — measured better than Qwen3.6 on the B-roll test questions (round 4).
      { id: "captioner", name: "Qwen3.5-35B-A3B vision projector (captions, with the dubbing translator)", license: "Apache-2.0", gpuGB: 19,
        src: [{ hf: "unsloth/Qwen3.5-35B-A3B-GGUF", rev: "bc014a17be43adabd7066b7a86075ff935c6a4e2", dir: "unsloth__Qwen3.5-35B-A3B-GGUF", files: ["mmproj-F16.gguf"] }] },
    ],
  },
];
