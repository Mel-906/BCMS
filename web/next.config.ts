import type { NextConfig } from "next";
import type { RemotePattern } from "next/dist/shared/lib/image-config";

const remotePatterns: RemotePattern[] = [];

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
if (supabaseUrl) {
  try {
    const { hostname } = new URL(supabaseUrl);
    remotePatterns.push(
      {
        protocol: "https",
        hostname,
        pathname: "/storage/v1/object/public/**",
      },
      {
        protocol: "https",
        hostname,
        pathname: "/storage/v1/object/sign/**",
      },
    );
  } catch (error) {
    console.warn("Invalid NEXT_PUBLIC_SUPABASE_URL for image optimization:", error);
  }
}

const nextConfig: NextConfig = {
  images: {
    remotePatterns,
  },
};

export default nextConfig;
