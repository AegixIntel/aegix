import { ImageResponse } from "next/og";
import { AEGIX_MARK_PATH, AEGIX_MARK_VIEWBOX } from "@/components/aegix-logo";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

/** Home-screen icon: the official AEGIX mark, with the padding iOS masks expect. */
export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#050505"
        }}
      >
        <svg width="128" height="128" viewBox={AEGIX_MARK_VIEWBOX}>
          <path d={AEGIX_MARK_PATH} fill="#f2f2f2" />
        </svg>
      </div>
    ),
    { ...size }
  );
}
