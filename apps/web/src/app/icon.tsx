import { ImageResponse } from "next/og";

export const size = { width: 64, height: 64 };
export const contentType = "image/png";

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
          background: "#05070d"
        }}
      >
        <svg width="40" height="40" viewBox="0 0 48 48" fill="none">
          <path d="M24 6 L42 40 H35.5 L29 28.5 H19 L12.5 40 H6 Z" fill="#8b7cff" />
          <path d="M21.5 23.5 H26.5 L24 18.8 Z" fill="#05070d" />
        </svg>
      </div>
    ),
    { ...size }
  );
}
