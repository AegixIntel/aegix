import { ImageResponse } from "next/og";
import { AEGIX_MARK_PATH, AEGIX_MARK_VIEWBOX } from "@/components/aegix-logo";

export const size = { width: 64, height: 64 };
export const contentType = "image/png";

/** Favicon: the official AEGIX mark in ink on the site's ink background. */
export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#efe6d3"
        }}
      >
        <svg width="52" height="52" viewBox={AEGIX_MARK_VIEWBOX}>
          <path d={AEGIX_MARK_PATH} fill="#14120f" />
        </svg>
      </div>
    ),
    { ...size }
  );
}
