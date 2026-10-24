// Fonts bundled with the app (src/renderer/assets/fonts, all SIL Open Font License 1.1 from the Google Fonts
// repository — see THIRD_PARTY_NOTICES.md). The same list feeds the font picker, the caption and graphics
// templates, and the font loader of the preview and the export, so a text looks the same everywhere.
// weight: "min max" for variable fonts, or one weight per file for static ones.
export const BUNDLED_FONTS = [
  { family: "Cairo", files: [{ file: "cairo/Cairo[slnt,wght].ttf", weight: "200 1000" }], arabic: true, style: "modern", label: "Cairo" },
  { family: "Alexandria", files: [{ file: "alexandria/Alexandria[wght].ttf", weight: "100 900" }], arabic: true, style: "modern", label: "Alexandria" },
  { family: "Readex Pro", files: [{ file: "readexpro/ReadexPro[HEXP,wght].ttf", weight: "160 700" }], arabic: true, style: "modern", label: "Readex Pro" },
  { family: "IBM Plex Sans Arabic", files: [{ file: "ibmplexsansarabic/IBMPlexSansArabic-Regular.ttf", weight: "400" }, { file: "ibmplexsansarabic/IBMPlexSansArabic-Medium.ttf", weight: "500" }, { file: "ibmplexsansarabic/IBMPlexSansArabic-Bold.ttf", weight: "700" }], arabic: true, style: "clean", label: "IBM Plex Sans Arabic" },
  { family: "Tajawal", files: [{ file: "tajawal/Tajawal-Regular.ttf", weight: "400" }, { file: "tajawal/Tajawal-Bold.ttf", weight: "700" }, { file: "tajawal/Tajawal-Black.ttf", weight: "900" }], arabic: true, style: "modern", label: "Tajawal" },
  { family: "Lalezar", files: [{ file: "lalezar/Lalezar-Regular.ttf", weight: "400" }], arabic: true, style: "display", label: "Lalezar" },
  { family: "El Messiri", files: [{ file: "elmessiri/ElMessiri[wght].ttf", weight: "400 700" }], arabic: true, style: "elegant", label: "El Messiri" },
  { family: "Changa", files: [{ file: "changa/Changa[wght].ttf", weight: "200 800" }], arabic: true, style: "tech", label: "Changa" },
  { family: "Noto Kufi Arabic", files: [{ file: "notokufiarabic/NotoKufiArabic[wght].ttf", weight: "100 900" }], arabic: true, style: "kufi", label: "Noto Kufi Arabic" },
  { family: "Baloo Bhaijaan 2", files: [{ file: "baloobhaijaan2/BalooBhaijaan2[wght].ttf", weight: "400 800" }], arabic: true, style: "playful", label: "Baloo Bhaijaan 2" },
  { family: "Marhey", files: [{ file: "marhey/Marhey[wght].ttf", weight: "300 700" }], arabic: true, style: "playful", label: "Marhey" },
  { family: "Lemonada", files: [{ file: "lemonada/Lemonada[wght].ttf", weight: "300 700" }], arabic: true, style: "playful", label: "Lemonada" },
  { family: "Noto Sans Arabic", files: [{ file: "notosansarabic/NotoSansArabic[wdth,wght].ttf", weight: "100 900" }], arabic: true, style: "clean", label: "Noto Sans Arabic" },
  { family: "Almarai", files: [{ file: "almarai/Almarai-Bold.ttf", weight: "700" }, { file: "almarai/Almarai-ExtraBold.ttf", weight: "800" }], arabic: true, style: "modern", label: "Almarai" },
  { family: "Zain", files: [{ file: "zain/Zain-Bold.ttf", weight: "700" }, { file: "zain/Zain-ExtraBold.ttf", weight: "800" }, { file: "zain/Zain-Black.ttf", weight: "900" }], arabic: true, style: "modern", label: "Zain" },
  { family: "Kufam", files: [{ file: "kufam/Kufam[wght].ttf", weight: "400 900" }], arabic: true, style: "kufi", label: "Kufam" },
  { family: "Reem Kufi", files: [{ file: "reemkufi/ReemKufi[wght].ttf", weight: "400 700" }], arabic: true, style: "kufi", label: "Reem Kufi" },
  { family: "Montserrat", files: [{ file: "montserrat/Montserrat[wght].ttf", weight: "100 900" }], arabic: false, style: "modern", label: "Montserrat" },
  { family: "Inter", files: [{ file: "inter/Inter[opsz,wght].ttf", weight: "100 900" }], arabic: false, style: "clean", label: "Inter" },
  { family: "Poppins", files: [{ file: "poppins/Poppins-Bold.ttf", weight: "700" }, { file: "poppins/Poppins-ExtraBold.ttf", weight: "800" }, { file: "poppins/Poppins-Black.ttf", weight: "900" }], arabic: false, style: "modern", label: "Poppins" },
  { family: "Bebas Neue", files: [{ file: "bebasneue/BebasNeue-Regular.ttf", weight: "400" }], arabic: false, style: "display", label: "Bebas Neue" },
  { family: "Anton", files: [{ file: "anton/Anton-Regular.ttf", weight: "400" }], arabic: false, style: "display", label: "Anton" },
  { family: "Plus Jakarta Sans", files: [{ file: "plusjakartasans/PlusJakartaSans[wght].ttf", weight: "200 800" }], arabic: false, style: "modern", label: "Plus Jakarta Sans" },
];

export const BUNDLED_FAMILIES = BUNDLED_FONTS.map((f) => f.family);
export const DEFAULT_FONT = "Cairo";

/** CSS font stack: the chosen family, then a bundled Arabic-capable fallback, then system fonts. */
export const fontStack = (family) => `"${String(family || DEFAULT_FONT).replace(/"/g, "")}", "Cairo", "Segoe UI", Tahoma, Arial, sans-serif`;
