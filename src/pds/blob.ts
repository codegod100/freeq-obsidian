import { requestUrl } from "obsidian";

export interface BlobResult {
	cid: string;
	url: string;
}

export interface BlobUploadErrorBody {
	error?: string;
	message?: string;
	step_up_url?: string;
	[key: string]: unknown;
}

export class BlobUploadError extends Error {
	status: number;
	body: BlobUploadErrorBody | string;

	constructor(status: number, body: BlobUploadErrorBody | string) {
		super(typeof body === "string" ? body : body.message || `Upload failed (${status})`);
		this.name = "BlobUploadError";
		this.status = status;
		this.body = body;
	}
}

type UploadContent = string | Uint8Array | ArrayBuffer;

function toBytes(content: UploadContent): Uint8Array {
	if (typeof content === "string") {
		return new TextEncoder().encode(content);
	}
	if (content instanceof Uint8Array) {
		return content;
	}
	return new Uint8Array(content);
}

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
	const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
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
	authToken?: string;
	content: UploadContent;
	filename?: string;
	mimeType?: string;
}): Promise<BlobResult> {
	const { serverUrl, did, authToken, content, filename, mimeType } = opts;
	const endpoint = serverUrl.replace(/\/$/, "") + "/api/v1/upload";

	const boundary = "----FreeQBlobBoundary" + Math.random().toString(36).slice(2);
	const name = filename || "note.md";
	const type = mimeType || "text/markdown";
	const encoder = new TextEncoder();
	const body = concatBytes(
		encoder.encode(
			`--${boundary}\r\nContent-Disposition: form-data; name="did"\r\n\r\n${did}\r\n`
		),
		encoder.encode(
			`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${type}\r\n\r\n`
		),
		toBytes(content),
		encoder.encode(`\r\n--${boundary}--\r\n`)
	);

	const res = await requestUrl({
		url: endpoint,
		method: "POST",
		contentType: `multipart/form-data; boundary=${boundary}`,
		throw: false,
		headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined,
		body: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
	});

	if (res.status >= 400) {
		let body: BlobUploadErrorBody | string = res.text;
		try {
			body = JSON.parse(res.text) as BlobUploadErrorBody;
		} catch {
			// keep text body
		}
		console.warn("[freeq] upload blob failed", {
			status: res.status,
			filename: name,
			mimeType: type,
			authToken: !!authToken,
			response: res.text.slice(0, 500),
			headers: res.headers,
		});
		throw new BlobUploadError(res.status, body);
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
