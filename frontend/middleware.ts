/**
 * Vercel Edge Middleware for asset URL redirects
 *
 * Interactive artifacts use relative URLs like `/channels/my-channel/assets/image.png`
 * but the asset endpoint only exists on the API host. This middleware redirects
 * those requests to the backend.
 */

// Edge runtime has process.env available
declare const process: { env: Record<string, string | undefined> };

const BACKEND_URL = process.env.VITE_BACKEND_URL;

export const config = {
  // Only match asset paths to minimize middleware overhead
  matcher: '/channels/:channelId/assets/:slug*',
};

export default function middleware(request: Request): Response {
  const url = new URL(request.url);

  if (!BACKEND_URL) {
    // Fail hard - don't silently serve 404s
    return new Response('VITE_BACKEND_URL not configured', { status: 500 });
  }

  // Redirect to the API host
  const redirectUrl = `${BACKEND_URL}${url.pathname}${url.search}`;

  return new Response(null, {
    status: 302,
    headers: {
      Location: redirectUrl,
    },
  });
}
