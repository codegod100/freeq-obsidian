import { requestUrl } from "obsidian";

export interface BlobResult {
	cid: string;
	url: string;
}

/**
 * Upload a blob via the FreeQ server's /api/v1/upload endpoint.
 * Uses requestUrl to bypass CORS (Obsidian runs in app://obsidian.md origin).
 * Requires an active IRC/WebSocket connection (the server checks session_dids).
 * The server has the PDS session (DPoP key + access token) from the OAuth broker.
 */
export async function uploadBlobViaFreeQ(opts: {
	serverUrl: string;
	did: string;
	content: string;
	filename?: string;
	mimeType?: string;
}): Promise<BlobResult> {
	const { serverUrl, did, content, filename, mimeType } = opts;
	const endpoint = serverUrl.replace(/\/$/, "") + "/api/v1/upload";

	const boundary = "----FreeQBlobBoundary" + Math.random().toString(36).slice(2);
	const parts: string[] = [];

	// did field
	parts.push(
		`--${boundary}\r\nContent-Disposition: form-data; name="did"\r\n\r\n${did}`
	);

	// file field
	const name = filename || "note.md";
	const type = mimeType || "text/markdown";
	const contentBytes = new TextEncoder().encode(content);
	const contentStr = Array.from(contentBytes)
		.map((b) => String.fromCharCode(b))
		.join("");
	parts.push(
		`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${type}\r\n\r\n${contentStr}`
	);

	parts.push(`--${boundary}--\r\n`);
	const body = parts.join("\r\n");

	const res = await requestUrl({
		url: endpoint,
		method: "POST",
		headers: {
			"Content-Type": `multipart/form-data; boundary=${boundary}`,
		},
		body,
	});

	if (res.status >= 400) {
		throw new Error(`Upload failed (${res.status}): ${res.text}`);
	}

	const data = res.json as {
		cid: string;
		url: string;
		size?: number;
		mimeType?: string;
	};

	if (!data.url) {
		throw new Error("Upload response missing URL");
	}

	return { cid: data.cid, url: data.url };
}
