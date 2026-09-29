import { uploadMedia, deleteMedia, ghPathFromUrl } from './github-media.js';

const NOTES_PER_PAGE = 10;
const SESSION_DURATION_SECONDS = 30*86400; // Session 有效期: 30 天
const SESSION_COOKIE = '__session';
export default {
	async fetch(request, env, ctx) {
		return await handleApiRequest(request, env, ctx);
	},
};

/**
 * 把 multipart 里的文件传到 GitHub 仓库，返回可直接外链的信息。
 * 注意：必须一次性读成字节，因为 GitHub Contents API 只接受 base64。
 */
async function uploadFileToGithub(env, file) {
	const bytes = new Uint8Array(await file.arrayBuffer());
	return uploadMedia(env, {
		bytes,
		filename: file.name || 'file',
		mime: file.type || 'application/octet-stream',
	});
}

/** 从远程 URL 取回字节再传 GitHub（Telegram 图片/视频/文件走这条路） */
async function uploadRemoteToGithub(env, downloadUrl, filename, mime) {
	const res = await fetch(downloadUrl);
	if (!res.ok) throw new Error(`从远端下载文件失败: ${res.status}`);
	const bytes = new Uint8Array(await res.arrayBuffer());
	return uploadMedia(env, { bytes, filename, mime });
}

/**
 * 尽力删除 GitHub 上的媒体文件；失败只记日志，绝不阻断数据库操作。
 * @param {object} env
 * @param {Array<string|null>} paths 仓库内路径，null / 空会被忽略
 */
async function safeDeleteGithubMedia(env, paths) {
	const list = (paths || []).filter(Boolean);
	if (!list.length || !env.GITHUB_TOKEN) return;
	for (const p of list) {
		try {
			await deleteMedia(env, p);
		} catch (e) {
			console.error(`[github-media] 删除失败（外链可能仍可访问）: ${p} -> ${e.message}`);
		}
	}
}

/** 从 files 数组里取出待删除的仓库路径 */
function ghPathsFromFiles(files) {
	return (files || []).map(f => f && f.path).filter(Boolean);
}

/** 从 pics / videos 里的外链 URL 反解出仓库路径 */
function ghPathsFromUrls(env, urls) {
	return (urls || []).map(u => ghPathFromUrl(env, u)).filter(Boolean);
}

/**
 * API 请求的统一处理器和路由
 */
async function handleApiRequest(request, env, ctx) {
	const { pathname } = new URL(request.url);

	// --- Memos 分享公开路由 ---
	// 匹配分享页面 /share/some-uuid
	const sharePageMatch = pathname.match(/^\/share\/([a-zA-Z0-9-]+)$/);
	if (sharePageMatch) {
		const publicId = sharePageMatch[1];
		// 构建目标 URL，将 publicId 作为查询参数
		const targetUrl = new URL('/share.html', request.url);
		targetUrl.searchParams.set('id', publicId);
		// 返回一个 302 临时重定向响应
		return Response.redirect(targetUrl.toString(), 302);
	}
	// 匹配获取分享内容的公开 API /api/public/note/some-uuid
	const publicNoteMatch = pathname.match(/^\/api\/public\/note\/([a-zA-Z0-9-]+)$/);
	if (publicNoteMatch && request.method === 'GET') {
		const publicId = publicNoteMatch[1];
		return handlePublicNoteRequest(publicId, env);
	}
	// 匹配获取分享 Raw 内容的公开 API /api/public/note/raw/some-uuid
	const publicRawNoteMatch = pathname.match(/^\/api\/public\/note\/raw\/([a-zA-Z0-9-]+)$/);
	if (publicRawNoteMatch && request.method === 'GET') {
		const publicId = publicRawNoteMatch[1];
		return handlePublicRawNoteRequest(publicId, env);
	}
	// --- Memos 分享公开路由 ---

	// 公开文件访问路由 (必须在身份验证之前)
	const publicFileMatch = pathname.match(/^\/api\/public\/file\/([a-zA-Z0-9-]+)$/);
	if (publicFileMatch) {
		const publicId = publicFileMatch[1];
		return handlePublicFileRequest(publicId, request, env);
	}

	const tgProxyMatch = pathname.match(/^\/api\/tg-media-proxy\/([^\/]+)$/);
	if (tgProxyMatch) {
		return handleTelegramProxy(request, env);
	}
	// --- Telegram Webhook 路由 ---
	const telegramMatch = pathname.match(/^\/api\/telegram_webhook\/([^\/]+)$/);
	if (request.method === 'POST' && telegramMatch) {
		const secret = telegramMatch[1];
		return handleTelegramWebhook(request, env, secret);
	}

	if (request.method === 'POST' && pathname === '/api/login') {
		return handleLogin(request, env);
	}
	if (request.method === 'POST' && pathname === '/api/logout') {
		return handleLogout(request, env);
	}

	// --- 从这里开始，所有 API 都需要认证 ---
	const session = await isSessionAuthenticated(request, env);
	if (!session) {
		return jsonResponse({ error: 'Unauthorized' }, 401);
	}

	if (request.method === 'POST' && pathname === '/api/notes/merge') {
		return handleMergeNotes(request, env);
	}

	const shareNoteMatch = pathname.match(/^\/api\/notes\/(\d+)\/share$/);
	if (shareNoteMatch) {
		const [, noteId] = shareNoteMatch;
		if (request.method === 'POST') {
			return handleShareNoteRequest(noteId, request, env);
		}
		if (request.method === 'DELETE') {
			return handleUnshareNoteRequest(noteId, env);
		}
	}

	const shareFileMatch = pathname.match(/^\/api\/notes\/(\d+)\/files\/([a-zA-Z0-9-]+)\/share$/);
	if (shareFileMatch && request.method === 'POST') {
		const [, noteId, fileId] = shareFileMatch;
		return handleShareFileRequest(noteId, fileId, request, env);
	}

	if (pathname === '/api/settings') {
		if (request.method === 'GET') {
			return handleGetSettings(request, env);
		}
		if (request.method === 'PUT') {
			return handleSetSettings(request, env);
		}
	}
	if (request.method === 'POST' && pathname === '/api/upload/image') {
		return handleStandaloneImageUpload(request, env, ctx);
	}
	const imageMatch = pathname.match(/^\/api\/images\/([a-zA-Z0-9-]+)$/);
	if (imageMatch) {
		const imageId = imageMatch[1];
		return handleServeStandaloneImage(imageId, env);
	}
	if (request.method === 'GET' && pathname === '/api/attachments') {
		return handleGetAllAttachments(request, env);
	}
	if (pathname === '/api/stats') {
		return handleStatsRequest(request, env);
	}
	if (pathname === '/api/tags') {
		return handleTagsList(request, env);
	}
	const fileMatch = pathname.match(/^\/api\/files\/([^\/]+)\/([^\/]+)$/);
	if (fileMatch) {
		const [, noteId, fileId] = fileMatch;
		return handleFileRequest(noteId, fileId, request, env);
	}
	if (pathname === '/api/notes/timeline') {
		return handleTimelineRequest(request, env);
	}
	if (pathname === '/api/search') {
		return handleSearchRequest(request, env);
	}
	const noteDetailMatch = pathname.match(/^\/api\/notes\/([^\/]+)$/);
	if (noteDetailMatch) {
		const noteId = noteDetailMatch[1];
		return handleNoteDetail(request, noteId, env);
	}

	if (pathname === '/api/notes') {
		return handleNotesList(request, env);
	}
	return new Response('Not Found', { status: 404 });
}

/**
 * 处理统计数据请求
 */
async function handleStatsRequest(request, env) {
	const db = env.DB;
	try {
		const memosCountQuery = db.prepare("SELECT COUNT(*) as total FROM notes");
		const tagsCountQuery = db.prepare("SELECT COUNT(DISTINCT tag_id) as total FROM note_tags");
		const oldestNoteQuery = db.prepare("SELECT MIN(updated_at) as oldest_ts FROM notes");

		// 使用 Promise.all 并行执行所有查询，以获得最佳性能
		const [memosResult, tagsResult, oldestNoteResult] = await Promise.all([
			memosCountQuery.first(),
			tagsCountQuery.first(),
			oldestNoteQuery.first()
		]);

		// 组装最终的 JSON 响应
		const stats = {
			memos: memosResult.total || 0,
			tags: tagsResult.total || 0,
			oldestNoteTimestamp: oldestNoteResult.oldest_ts || null
		};
		return jsonResponse(stats);
	} catch (e) {
		console.error("Stats Error:", e.message);
		return jsonResponse({ error: 'Database Error', message: e.message }, 500);
	}
}

/**
 * 处理时间线数据请求，返回按 年 -> 月 -> 日 结构化的笔记数量统计
 */
async function handleTimelineRequest(request, env) {
	const db = env.DB;
	try {
		const { searchParams } = new URL(request.url);
		const timezone = searchParams.get('timezone') || 'UTC';
		// D1 不直接支持 strftime 或 to_char, 我们需要获取所有创建时间，然后在 JS 中处理
		// 注意：如果笔记数量巨大 (几十万条)，这个查询可能会有性能问题。
		// 对于几千到几万条笔记，这是完全可以接受的。
		const stmt = db.prepare("SELECT updated_at FROM notes ORDER BY updated_at DESC");
		const { results } = await stmt.all();
		if (!results) {
			return jsonResponse({});
		}
		const timezoneFormatter = new Intl.DateTimeFormat('en-US', { // 'en-US' 只是为了格式，不影响结果
			timeZone: timezone,
			year: 'numeric',
			month: 'numeric',
			day: 'numeric',
		});
		// 在 JavaScript 中进行分组统计
		const timeline = {};
		for (const note of results) {
			const date = new Date(note.updated_at);
			const parts = timezoneFormatter.formatToParts(date);
			const year = parseInt(parts.find(p => p.type === 'year').value, 10);
			const month = parseInt(parts.find(p => p.type === 'month').value, 10);
			const day = parseInt(parts.find(p => p.type === 'day').value, 10);

			// 初始化年
			if (!timeline[year]) {
				timeline[year] = { count: 0, months: {} };
			}
			// 初始化月
			if (!timeline[year].months[month]) {
				timeline[year].months[month] = { count: 0, days: {} };
			}
			// 初始化日
			if (!timeline[year].months[month].days[day]) {
				timeline[year].months[month].days[day] = { count: 0 };
			}
			// 递增计数
			timeline[year].count++;
			timeline[year].months[month].count++;
			timeline[year].months[month].days[day].count++;
		}
		return jsonResponse(timeline);
	} catch (e) {
		console.error("Timeline Error:", e.message);
		return jsonResponse({ error: 'Database Error', message: e.message }, 500);
	}
}
/**
 * 处理全文搜索请求，支持分页和叠加筛选条件
 */
async function handleSearchRequest(request, env) {
	const { searchParams } = new URL(request.url);
	const query = searchParams.get('q');

	// 1. 如果搜索查询为空或只包含空格，则将请求委托给 handleNotesList
	if (!query || query.trim().length === 0) {
		// 直接调用 handleNotesList 并返回其结果，实现无缝回退
		return handleNotesList(request, env);
	}
	// 2. 保留对过短查询的检查
	if (query.trim().length < 2) {
		return jsonResponse({ notes: [], hasMore: false });
	}

	// --- 引入分页逻辑 ---
	const page = parseInt(searchParams.get('page') || '1');
	const offset = (page - 1) * NOTES_PER_PAGE;
	const limit = NOTES_PER_PAGE;
	const tagName = searchParams.get('tag');
	const startTimestamp = searchParams.get('startTimestamp');
	const endTimestamp = searchParams.get('endTimestamp');
	const isFavoritesMode = searchParams.get('favorites') === 'true';

	const db = env.DB;
	try {
		// Escape double quotes and wrap in double quotes to handle hyphens and other special characters
		// This treats the query as a literal phrase prefix.
		const escapedQuery = query.replace(/"/g, '""');
		let whereClauses = ["notes_fts MATCH ?"];
		let bindings = [`"${escapedQuery}"*`];
		let joinClause = "";
		if (isFavoritesMode) {
			whereClauses.push("n.is_favorited = 1");
		}
		if (startTimestamp && endTimestamp) {
			const startMs = parseInt(startTimestamp);
			const endMs = parseInt(endTimestamp);
			if (!isNaN(startMs) && !isNaN(endMs)) {
				whereClauses.push("n.updated_at >= ? AND n.updated_at < ?");
				bindings.push(startMs, endMs);
			}
		}
		if (tagName) {
			joinClause = `
                JOIN note_tags nt ON n.id = nt.note_id
                JOIN tags t ON nt.tag_id = t.id
            `;
			whereClauses.push("t.name = ?");
			bindings.push(tagName);
		}

		const whereString = whereClauses.join(" AND ");
		const stmt = db.prepare(`
            SELECT n.* FROM notes n
            JOIN notes_fts fts ON n.id = fts.rowid
            ${joinClause}
            WHERE ${whereString}
            ORDER BY rank
            LIMIT ? OFFSET ?
        `);

		bindings.push(limit + 1, offset);
		const { results: notesPlusOne } = await stmt.bind(...bindings).all();

		const hasMore = notesPlusOne.length > limit;
		const notes = notesPlusOne.slice(0, limit);

		notes.forEach(note => {
			if (typeof note.files === 'string') {
				try { note.files = JSON.parse(note.files); } catch (e) { note.files = []; }
			}
		});
		return jsonResponse({ notes, hasMore });
	} catch (e) {
		console.error("Search Error:", e.message);
		return jsonResponse({ error: 'Database Error', message: e.message }, 500);
	}
}

/**
 * 获取所有标签及其使用次数
 */
async function handleTagsList(request, env) {
	const db = env.DB;
	try {
		// 使用 LEFT JOIN 和 COUNT 来统计每个标签关联的笔记数量
		// ORDER BY count DESC, name ASC 实现了按数量降序、名称升序的排序
		const stmt = db.prepare(`
            SELECT t.name, COUNT(nt.note_id) as count
            FROM tags t
            LEFT JOIN note_tags nt ON t.id = nt.tag_id
            GROUP BY t.id, t.name
            HAVING count > 0 -- 只返回被使用过的标签
            ORDER BY count DESC, t.name ASC
        `);
		const { results } = await stmt.all();
		return jsonResponse(results);
	} catch (e) {
		console.error("Tags List Error:", e.message);
		return jsonResponse({ error: 'Database Error' }, 500);
	}
}

/**
 * 检查 Session Cookie 是否有效
 */
async function isSessionAuthenticated(request, env) {
	const cookieHeader = request.headers.get('Cookie');
	if (!cookieHeader || !cookieHeader.includes(SESSION_COOKIE)) {
		return null;
	}
	const cookies = cookieHeader.split(';').map(c => c.trim());
	const sessionCookie = cookies.find(c => c.startsWith(`${SESSION_COOKIE}=`));
	if (!sessionCookie) return null;
	const sessionId = sessionCookie.split('=')[1];
	if (!sessionId) return null;
	const session = await env.NOTES_KV.get(`session:${sessionId}`, 'json');
	return session || null;
}

/**
 * 处理登录请求
 */
async function handleLogin(request, env) {
	try {
		const { username, password } = await request.json();
		if (username === env.USERNAME && password === env.PASSWORD) {
			const sessionId = crypto.randomUUID();
			const sessionData = { username, loggedInAt: Date.now() };
			await env.NOTES_KV.put(`session:${sessionId}`, JSON.stringify(sessionData), {
				expirationTtl: SESSION_DURATION_SECONDS,
			});
			const headers = new Headers();
			headers.append('Set-Cookie', `${SESSION_COOKIE}=${sessionId}; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_DURATION_SECONDS}`);
			return jsonResponse({ success: true }, 200, headers);
		}
	} catch (e) {
		console.error("Login Error:", e.message);
	}
	return jsonResponse({ error: 'Invalid credentials' }, 401);
}

/**
 * 处理退出登录请求
 */
async function handleLogout(request, env) {
	const cookieHeader = request.headers.get('Cookie');
	if (cookieHeader && cookieHeader.includes(SESSION_COOKIE)) {
		const sessionId = cookieHeader.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`))?.[1];
		if (sessionId) {
			await env.NOTES_KV.delete(`session:${sessionId}`);
		}
	}
	const headers = new Headers();
	headers.append('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
	return jsonResponse({ success: true }, 200, headers);
}

/**
 * 从 KV 中获取用户设置。如果 KV 中没有，则返回默认值。
 */
async function handleGetSettings(request, env) {
	const defaultSettings = {
		showSearchBar: true,
		showStatsCard: true,
		showCalendar: true,
		showTags: true,
		showTimeline: true,
		showRightSidebar: true,
		hideEditorInWaterfall: false,
		showHeatmap: true, // 默认显示热力图
		surfaceColor: '#ffffff',
		surfaceColorDark: '#151f31',
		surfaceOpacity: 1,
		backgroundOpacity: 1, // 默认完全不透明
		backgroundImage: '/bg.jpg',
		backgroundBlur: 0,
		waterfallCardWidth: 320,
		enableDateGrouping: false,
		telegramProxy: false,
		showFavorites: true,  // 控制收藏夹
		showArchive: true,      // 控制归档
		enablePinning: true,    // 控制置顶功能
		enableSharing: true,    // 控制分享功能
		enableContentTruncation: false,
	};

	let savedSettings = await env.NOTES_KV.get('user_settings', 'json');

	// 如果 KV 中没有设置，则返回默认值
	if (!savedSettings) {
		return jsonResponse(defaultSettings);
	}
	return jsonResponse(savedSettings);
}

/**
 * 将用户设置保存到 KV 中。
 */
async function handleSetSettings(request, env) {
	try {
		const settingsToSave = await request.json();
		await env.NOTES_KV.put('user_settings', JSON.stringify(settingsToSave));
		return jsonResponse({ success: true });
	} catch (e) {
		console.error("Set Settings Error:", e.message);
		return jsonResponse({ error: 'Failed to save settings' }, 500);
	}
}

/**
 * 处理笔记列表的 GET 和 POST
 */
async function handleNotesList(request, env) {
	const db = env.DB;

	try {
		switch (request.method) {
			case 'GET': {
				const url = new URL(request.url);
				const page = parseInt(url.searchParams.get('page') || '1');
				const offset = (page - 1) * NOTES_PER_PAGE;
				const limit = NOTES_PER_PAGE;

				const startTimestamp = url.searchParams.get('startTimestamp');
				const endTimestamp = url.searchParams.get('endTimestamp');
				const tagName = url.searchParams.get('tag');
				const isFavoritesMode = url.searchParams.get('favorites') === 'true';
				const isArchivedMode = url.searchParams.get('archived') === 'true';

				let whereClauses = [];
				let bindings = [];
				let joinClause = "";

				if (isArchivedMode) {
					whereClauses.push("n.is_archived = 1");
				} else {
					// 默认（包括收藏夹）都应该排除已归档的
					whereClauses.push("n.is_archived = 0");
				}

				if (startTimestamp && endTimestamp) {
					// 将字符串时间戳转换为数字
					const startMs = parseInt(startTimestamp);
					const endMs = parseInt(endTimestamp);

					if (!isNaN(startMs) && !isNaN(endMs)) {
						whereClauses.push("updated_at >= ? AND updated_at < ?");
						bindings.push(startMs, endMs);
					}
				}
				if (tagName) {
					joinClause = `
                    JOIN note_tags nt ON n.id = nt.note_id
                    JOIN tags t ON nt.tag_id = t.id
                `;
					whereClauses.push("t.name = ?");
					bindings.push(tagName);
				}
				if (isFavoritesMode) {
					whereClauses.push("n.is_favorited = 1");
				}
				const whereClause = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

				const query = `
                SELECT n.* FROM notes n
                ${joinClause}
                ${whereClause}
                ORDER BY n.is_pinned DESC, n.updated_at DESC
                LIMIT ? OFFSET ?
            `;

				// 将分页参数添加到 bindings 数组的末尾
				bindings.push(limit + 1, offset);

				const notesStmt = db.prepare(query);
				const { results: notesPlusOne } = await notesStmt.bind(...bindings).all();

				const hasMore = notesPlusOne.length > limit;
				const notes = notesPlusOne.slice(0, limit);

				notes.forEach(note => {
					if (typeof note.files === 'string') {
						try { note.files = JSON.parse(note.files); } catch (e) { note.files = []; }
					}
				});

				return jsonResponse({ notes, hasMore });
			}

			case 'POST': {
				const formData = await request.formData();
				const content = formData.get('content')?.toString() || '';
				const files = formData.getAll('file');

				if (!content.trim() && files.every(f => !f.name)) {
					return jsonResponse({ error: 'Content or file is required.' }, 400);
				}

				const now = Date.now();
				const filesMeta = [];

				// 【核心修改】在插入数据库前，先提取图片 URL
				const picUrls = extractImageUrls(content);

				// 【核心修改】在 INSERT 语句中加入新的 pics 字段
				const insertStmt = db.prepare(
					"INSERT INTO notes (content, files, is_pinned, created_at, updated_at, pics) VALUES (?, ?, 0, ?, ?, ?) RETURNING id"
				);
				// 先用一个空的 files 数组插入
				// 【核心修改】将提取出的 picUrls 绑定到 SQL 语句中
				const { id: noteId } = await insertStmt.bind(content, "[]", now, now, picUrls).first();
				if (!noteId) {
					throw new Error("Failed to create note and get ID.");
				}

				// --- 只有非图片类型才算作 "附件" (files)；图片走粘贴上传进 pics ---
				for (const file of files) {
					if (file.name && file.size > 0 && !file.type.startsWith('image/')) {
						const media = await uploadFileToGithub(env, file);
						filesMeta.push({
							id: crypto.randomUUID(),
							name: file.name,
							size: file.size,
							type: file.type,
							url: media.url,     // jsDelivr 直链
							path: media.path,   // 删除笔记时要用到
						});
					}
				}

				// 如果有非图片附件，再更新数据库中的 files 字段
				if (filesMeta.length > 0) {
					const updateFilesStmt = db.prepare("UPDATE notes SET files = ? WHERE id = ?");
					await updateFilesStmt.bind(JSON.stringify(filesMeta), noteId).run();
				}

				await processNoteTags(db, noteId, content);
				// 获取完整的笔记返回给前端
				const newNote = await db.prepare("SELECT * FROM notes WHERE id = ?").bind(noteId).first();
				if (typeof newNote.files === 'string') {
					newNote.files = JSON.parse(newNote.files);
				}

				return jsonResponse(newNote, 201);
			}
		}
	} catch (e) {
		console.error("D1 Error:", e.message, e.cause);
		return jsonResponse({ error: 'Database Error', message: e.message }, 500);
	}
}

/**
 * 处理单条笔记的 PUT 和 DELETE
 */
async function handleNoteDetail(request, noteId, env) {
	const db = env.DB;
	const id = parseInt(noteId);
	if (isNaN(id)) {
		return new Response('Invalid Note ID', { status: 400 });
	}

	try {
		// 首先获取现有笔记，用于文件删除和返回数据
		let existingNote = await db.prepare("SELECT * FROM notes WHERE id = ?").bind(id).first();
		if (!existingNote) {
			return new Response('Not Found', { status: 404 });
		}
		// 确保 files 字段是数组
		try {
			if (typeof existingNote.files === 'string') {
				existingNote.files = JSON.parse(existingNote.files);
			}
		} catch(e) {
			existingNote.files = [];
		}

		switch (request.method) {
			case 'PUT': {
				const formData = await request.formData();
				const shouldUpdateTimestamp = formData.get('update_timestamp') !== 'false';

				if (formData.has('content')) {
					const content = formData.get('content')?.toString() ?? existingNote.content;
					let currentFiles = existingNote.files;

					// --- 附件删除：先按 path 从 GitHub 仓库删除，再从 files 数组移除 ---
					const filesToDelete = JSON.parse(formData.get('filesToDelete') || '[]');
					if (filesToDelete.length > 0) {
						const doomed = currentFiles.filter(file => filesToDelete.includes(file.id));
						await safeDeleteGithubMedia(env, ghPathsFromFiles(doomed));
						currentFiles = currentFiles.filter(file => !filesToDelete.includes(file.id));
					}

					// 在处理完文件删除后，检查笔记是否应该被删除
					const hasNewFiles = formData.getAll('file').some(f => f.name && f.size > 0);
					if (content.trim() === '' && currentFiles.length === 0 && !hasNewFiles) {
						// 笔记即将变空：清理 GitHub 上剩余的附件，再删数据库记录
						await safeDeleteGithubMedia(env, ghPathsFromFiles(existingNote.files));
						// 同时清理正文里引用的图片（pics 存的是 jsDelivr 外链）
						try {
							const oldPics = JSON.parse(existingNote.pics || '[]');
							await safeDeleteGithubMedia(env, ghPathsFromUrls(env, oldPics));
						} catch (e) { /* pics 解析失败则跳过 */ }
						await db.prepare("DELETE FROM notes WHERE id = ?").bind(id).run();
						return jsonResponse({ success: true, noteDeleted: true });
					}
					// 处理新附件上传
					const newFiles = formData.getAll('file');
					for (const file of newFiles) {
						// 只有当文件存在，并且不是图片时，才作为附件处理
						if (file.name && file.size > 0 && !file.type.startsWith('image/')) {
							const media = await uploadFileToGithub(env, file);
							currentFiles.push({
								id: crypto.randomUUID(),
								name: file.name,
								size: file.size,
								type: file.type,
								url: media.url,
								path: media.path,
							});
						}
					}

					// 在更新数据库前，提取新的图片 URL 列表
					const picUrls = extractImageUrls(content);
					const newTimestamp = shouldUpdateTimestamp ? Date.now() : existingNote.updated_at;
					// 在 UPDATE 语句中加入 pics 字段的更新
					const stmt = db.prepare(
						"UPDATE notes SET content = ?, files = ?, updated_at = ?, pics = ? WHERE id = ?"
					);
					await stmt.bind(content, JSON.stringify(currentFiles), newTimestamp, picUrls, id).run();
					await processNoteTags(db, id, content);
				}

				if (formData.has('isPinned')) { // --- 这是置顶状态的更新 ---
					const isPinned = formData.get('isPinned') === 'true' ? 1 : 0;
					const stmt = db.prepare("UPDATE notes SET is_pinned = ? WHERE id = ?");
					await stmt.bind(isPinned, id).run();
				}
				if (formData.has('isFavorited')) {
					const isFavorited = formData.get('isFavorited') === 'true' ? 1 : 0;
					const stmt = db.prepare("UPDATE notes SET is_favorited = ? WHERE id = ?");
					await stmt.bind(isFavorited, id).run();
				}
				if (formData.has('is_archived')) {
					const isArchived = formData.get('is_archived') === 'true' ? 1 : 0;
					const stmt = db.prepare("UPDATE notes SET is_archived = ? WHERE id = ?");
					await stmt.bind(isArchived, id).run();
				}

				const updatedNote = await db.prepare("SELECT * FROM notes WHERE id = ?").bind(id).first();
				if (typeof updatedNote.files === 'string') {
					updatedNote.files = JSON.parse(updatedNote.files);
				}
				return jsonResponse(updatedNote);
			}

			case 'DELETE': {
				// 1. 附件：files[].path 就是仓库内路径
				const pathsToDelete = ghPathsFromFiles(existingNote.files);

				// 2. 正文里的图片：pics 存的是 jsDelivr 外链，反解出路径
				let picUrls = [];
				if (typeof existingNote.pics === 'string') {
					try { picUrls = JSON.parse(existingNote.pics); } catch (e) { }
				}
				pathsToDelete.push(...ghPathsFromUrls(env, picUrls));

				// 3. videos 里同样是外链
				let videoUrls = [];
				if (typeof existingNote.videos === 'string') {
					try { videoUrls = JSON.parse(existingNote.videos); } catch (e) { }
				}
				pathsToDelete.push(...ghPathsFromUrls(env, videoUrls));

				// 尽力删除，失败不阻断数据库删除（外链可能仍可访问，这是方案固有特性）
				await safeDeleteGithubMedia(env, pathsToDelete);

				await db.prepare("DELETE FROM notes WHERE id = ?").bind(id).run();

				return new Response(null, { status: 204 });
			}
		}
	} catch (e) {
		console.error("D1 Error:", e.message, e.cause);
		return jsonResponse({ error: 'Database Error', message: e.message }, 500);
	}
}

async function handleFileRequest(noteId, fileId, request, env) {
	const db = env.DB;
	const id = parseInt(noteId);
	if (isNaN(id)) {
		return new Response('Invalid Note ID', { status: 400 });
	}

	// 尝试从数据库获取元数据
	const note = await db.prepare("SELECT files FROM notes WHERE id = ?").bind(id).first();

	// 【核心修改】即使 note 不存在或 files 为空，我们也不立即返回 404，
	// 因为图片可能只记录在 pics 字段中。

	let files = [];
	if (note && typeof note.files === 'string') {
		try {
			files = JSON.parse(note.files);
		} catch (e) {
			// JSON 解析失败则忽略
		}
	}

	const fileMeta = files.find(f => f.id === fileId);

	// 文件本体现在托管在 GitHub + jsDelivr，这里只做 302 跳转，
	// 不再由 Worker 代理字节流（省 CPU，也不消耗 GitHub API 额度）。
	if (!fileMeta || !fileMeta.url) {
		return new Response('File not found in storage', { status: 404 });
	}

	const headers = new Headers();
	headers.set('Location', fileMeta.url);
	headers.set('Cache-Control', 'public, max-age=86400');
	return new Response(null, { status: 302, headers });
}
/**
 *  将 Telegram 的格式化实体 (entities) 转换为 Markdown 文本
 *
 * @param {string} text 原始文本
 * @param {Array<object>} entities 从 Telegram API 收到的标签数组。
 * @returns {string} 格式化后的、高度兼容的 Markdown 文本。
 */
function telegramEntitiesToMarkdown(text, entities = []) {
	if (!entities || entities.length === 0) {
		return text;
	}

	// 优先级决定了标签的嵌套顺序。数字越小，越在外层。
	const tagPriority = {
		'text_link': 10,
		'bold': 20,
		'italic': 30, // 使用 _ 作为斜体标记，避免与 ** 的 * 冲突
		'underline': 40,
		'strikethrough': 50,
		'spoiler': 60,
		'code': 70,
		'pre': 80
	};
	const mods = Array.from({ length: text.length + 1 }, () => ({ openTags: [], closeTags: [] }));
	entities.forEach(entity => {
		const { type, offset, length, url, language } = entity;
		const endOffset = offset + length;
		const priority = tagPriority[type] || 100;
		let startTag = '', endTag = '';
		switch (type) {
			case 'bold':          startTag = '**'; endTag = '**'; break;
			case 'italic':        startTag = '_';  endTag = '_';  break;
			case 'underline':     startTag = '__'; endTag = '__'; break;
			case 'strikethrough': startTag = '~~'; endTag = '~~'; break;
			case 'spoiler':       startTag = '||'; endTag = '||'; break;
			case 'code':          startTag = '`';  endTag = '`';  break;
			case 'text_link':
				startTag = '[';
				const encodedUrl = url.replace(/\(/g, '%28').replace(/\)/g, '%29');
				endTag = `](${encodedUrl})`;
				break;
			case 'pre':
				startTag = `\`\`\`${language || ''}\n`; endTag = '\n```'; break;
		}

		if (startTag) {
			mods[offset].openTags.push({ tag: startTag, priority });
			mods[endOffset].closeTags.push({ tag: endTag, priority });
		}
	});

	let result = '';
	let lastIndex = 0;
	const adjacentSensitiveTags = ['**', '_', '__', '~~', '||', '`'];

	for (let i = 0; i <= text.length; i++) {
		const mod = mods[i];
		if (mod.openTags.length === 0 && mod.closeTags.length === 0) {
			continue;
		}
		result += text.substring(lastIndex, i);
		//   - 闭合标签按优先级从高到低（内层先关）
		//   - 起始标签按优先级从低到高（外层先开）
		const closeTags = mod.closeTags.sort((a, b) => b.priority - a.priority);
		const openTags = mod.openTags.sort((a, b) => a.priority - b.priority);

		closeTags.forEach(({ tag }) => {
			if (adjacentSensitiveTags.includes(tag) && result.endsWith(tag)) {
				result += '\u200B'; // 插入零宽度空格
			}
			result += tag;
		});

		openTags.forEach(({ tag }) => {
			if (adjacentSensitiveTags.includes(tag) && result.endsWith(tag)) {
				result += '\u200B'; // 插入零宽度空格
			}
			result += tag;
		});

		lastIndex = i;
	}

	if (lastIndex < text.length) {
		result += text.substring(lastIndex);
	}
	result = result.replace(
		/\*\*((?:(?:\p{Emoji}|\p{Emoji_Component})+))\*\*/gu,
		'$1'
	);
	result = result.replace(/\*\*(\s+)\*\*/g, '$1');
	result = result.replace(/\*\*(\s+)(.*?)\*\*/g, '$1**$2**');
	return result;
}

/**
 * 代理 Telegram 媒体文件请求。
 * 接收一个 file_id，实时获取临时下载链接并重定向用户。
 */
async function handleTelegramProxy(request, env) {
	const { pathname } = new URL(request.url);
	const match = pathname.match(/^\/api\/tg-media-proxy\/([^\/]+)$/);

	if (!match || !match[1]) {
		return new Response('Invalid file_id', { status: 400 });
	}

	const fileId = match[1];
	const botToken = env.TELEGRAM_BOT_TOKEN;

	if (!botToken) {
		console.error("TELEGRAM_BOT_TOKEN secret is not set.");
		return new Response('Bot not configured', { status: 500 });
	}

	try {
		// 1. 调用 getFile API
		const getFileUrl = `https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`;
		const fileInfoRes = await fetch(getFileUrl);
		const fileInfo = await fileInfoRes.json();

		if (!fileInfo.ok) {
			console.error(`Telegram getFile API error for file_id ${fileId}:`, fileInfo.description);
			return new Response(`Telegram API error: ${fileInfo.description}`, { status: 502 }); // 502 Bad Gateway
		}

		// 2. 构建临时的下载链接
		const temporaryDownloadUrl = `https://api.telegram.org/file/bot${botToken}/${fileInfo.result.file_path}`;

		// 3. 返回 302 重定向
		return Response.redirect(temporaryDownloadUrl, 302);

	} catch (e) {
		console.error("Telegram Proxy Error:", e.message);
		return new Response('Failed to proxy Telegram media', { status: 500 });
	}
}

/**
 * - 处理来自 Telegram Bot 的 Webhook 请求
 * - 视频：保存 file_id，并在正文中嵌入指向 Worker 代理的链接，实现动态播放。
 * - 图片/文件：仍然二次上传到 R2，保证永久可用。
 */
async function handleTelegramWebhook(request, env, secret) {
	if (!env.TELEGRAM_WEBHOOK_SECRET || secret !== env.TELEGRAM_WEBHOOK_SECRET) {
		return new Response('Unauthorized', { status: 401 });
	}
	let chatId = null;
	const botToken = env.TELEGRAM_BOT_TOKEN;
	try {
		const update = await request.json();
		const message = update.message || update.channel_post;
		if (!message) {
			return new Response('OK', { status: 200 });
		}

		const authorizedIdsStr = env.AUTHORIZED_TELEGRAM_IDS;
		if (!authorizedIdsStr) {
			console.error("安全警告：AUTHORIZED_TELEGRAM_IDS 环境变量未设置。");
			return new Response('OK', { status: 200 });
		}
		chatId = message.chat.id;
		const senderId = message.from?.id;
		if (!senderId || authorizedIdsStr != senderId.toString()) {
			console.log(`已阻止来自未授权或未知用户 ${senderId || ''} 的请求。`);
			return new Response('OK', { status: 200 });
		}

		const db = env.DB;
		if (!botToken) {
			console.error("TELEGRAM_BOT_TOKEN secret is not set.");
			return new Response('Bot not configured', { status: 500 });
		}

		const text = message.text || message.caption || '';
		const entities = message.entities || message.caption_entities || [];
		const contentFromTelegram = telegramEntitiesToMarkdown(text, entities);

		let forwardInfo = '';
		if (message.forward_from_chat) {
			const chat = message.forward_from_chat;
			const title = chat.title || 'a channel';
			if (chat.username) {
				const channelUrl = `https://t.me/${chat.username}`;
				forwardInfo = `*Forwarded from [${title}](${channelUrl})*`;
			} else {
				forwardInfo = `*Forwarded from ${title}*`;
			}
		} else if (message.forward_from) {
			const fromName = `${message.forward_from.first_name || ''} ${message.forward_from.last_name || ''}`.trim();
			forwardInfo = `*Forwarded from ${fromName}*`;
		}

		let replyMarkdown = '';
		if (message.reply_to_message) {
			const originalMessage = message.reply_to_message;
			const originalText = originalMessage.text || originalMessage.caption || '';
			const originalEntities = originalMessage.entities || originalMessage.caption_entities || [];
			const originalContentMarkdown = telegramEntitiesToMarkdown(originalText, originalEntities);
			if (originalContentMarkdown.trim()) {
				replyMarkdown = originalContentMarkdown.trim().split('\n').map(line => `> ${line}`).join('\n');
			}
		}

		const photo = message.photo ? message.photo[message.photo.length - 1] : null;
		const document = message.document;
		const video = message.video;

		if (!contentFromTelegram.trim() && !photo && !document && !video) {
			return new Response('OK', { status: 200 });
		}
		const defaultSettings = { telegramProxy: false };
		let userSettings = await env.NOTES_KV.get('user_settings', 'json');
		if (!userSettings) {
			userSettings = defaultSettings;
		}
		const settings = { ...defaultSettings, ...userSettings };
		const now = Date.now();
		let filesMeta = [];
		let picObjects = [];
		let videoObjects = [];
		let mediaEmbeds = [];

		const insertStmt = db.prepare("INSERT INTO notes (content, files, is_pinned, created_at, updated_at, pics, videos) VALUES (?, ?, 0, ?, ?, ?, ?) RETURNING id");
		const { id: noteId } = await insertStmt.bind('', '[]', now, now, '[]', '[]').first();
		if (!noteId) {
			throw new Error("无法在数据库中创建笔记记录。");
		}

		// 图片处理（从 Telegram 下载后转存 GitHub，拿到 jsDelivr 外链）
		if (photo) {
			const getFileUrl = `https://api.telegram.org/bot${botToken}/getFile?file_id=${photo.file_id}`;
			const fileInfoRes = await fetch(getFileUrl);
			const fileInfo = await fileInfoRes.json();
			if (!fileInfo.ok) throw new Error(`Telegram getFile API 错误 (photo): ${fileInfo.description}`);
			const filePath = fileInfo.result.file_path;
			const fileName = `photo_${message.message_id}.${(filePath.split('.').pop() || 'jpg')}`;
			const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;

			const media = await uploadRemoteToGithub(env, downloadUrl, fileName, 'image/jpeg');
			picObjects.push(media.url); // pics 存 URL 字符串
			mediaEmbeds.push(`![${fileName}](${media.url})`);
		}

		if (video) {
			if (settings.telegramProxy) {
				// --- 代理模式 ---
				const proxyUrl = `/api/tg-media-proxy/${video.file_id}`;
				videoObjects.push(proxyUrl);
				mediaEmbeds.push(`<video src="${proxyUrl}" width="100%" controls muted></video>`);
			} else {
				// --- 转存 GitHub 模式 ---
				const getFileUrl = `https://api.telegram.org/bot${botToken}/getFile?file_id=${video.file_id}`;
				const fileInfoRes = await fetch(getFileUrl);
				const fileInfo = await fileInfoRes.json();
				if (!fileInfo.ok) throw new Error(`Telegram getFile API 错误 (video): ${fileInfo.description}`);
				const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${fileInfo.result.file_path}`;
				const vName = `video_${message.message_id}.${(fileInfo.result.file_path.split('.').pop() || 'mp4')}`;
				const media = await uploadRemoteToGithub(env, downloadUrl, vName, 'video/mp4');
				videoObjects.push(media.url);
				mediaEmbeds.push(`<video src="${media.url}" width="100%" controls muted></video>`);
			}
		}

		// 文件处理（根据设置决定模式）
		if (document) {
			if (settings.telegramProxy) {
				// --- 代理模式 ---
				// 注意：代理文件时，我们无法在笔记中直接展示它，只能存一个元信息
				filesMeta.push({
					type: 'telegram_document', // 特殊类型
					file_id: document.file_id,
					name: document.file_name,
					size: document.file_size
				});
				// 可以在正文加一个占位符，但这需要前端支持渲染
				// finalContent += `\n\n[Proxy File: ${document.file_name}]`;
			} else {
				// --- 转存 GitHub 模式 ---
				const getFileUrl = `https://api.telegram.org/bot${botToken}/getFile?file_id=${document.file_id}`;
				const fileInfoRes = await fetch(getFileUrl);
				const fileInfo = await fileInfoRes.json();
				if (!fileInfo.ok) throw new Error(`Telegram getFile API 错误 (document): ${fileInfo.description}`);
				const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${fileInfo.result.file_path}`;
				const media = await uploadRemoteToGithub(
					env, downloadUrl, document.file_name, document.mime_type || 'application/octet-stream'
				);
				filesMeta.push({
					id: crypto.randomUUID(),
					name: document.file_name,
					size: document.file_size,
					type: document.mime_type || 'application/octet-stream',
					url: media.url,
					path: media.path,
				});
			}
		}

		const contentParts = [];
		if (forwardInfo) contentParts.push(forwardInfo);
		if (mediaEmbeds.length > 0) contentParts.push(mediaEmbeds.join('\n'));
		if (replyMarkdown) contentParts.push(replyMarkdown);
		if (contentFromTelegram.trim()) contentParts.push(contentFromTelegram.trim());

		let finalContent = "#TG " + contentParts.join('\n\n');

		const updateStmt = db.prepare("UPDATE notes SET content = ?, files = ?, pics = ?, videos = ? WHERE id = ?");
		await updateStmt.bind(
			finalContent,
			JSON.stringify(filesMeta),
			JSON.stringify(picObjects),
			JSON.stringify(videoObjects), // [新增] 绑定 videoObjects
			noteId
		).run();

		await processNoteTags(db, noteId, finalContent);
		await sendTelegramMessage(chatId, `✅ 笔记已保存！ (ID: ${noteId})`, botToken);

	} catch (e) {
		console.error("Telegram Webhook Error:", e.message);
		if (chatId && botToken) {
			await sendTelegramMessage(chatId, `❌ 保存笔记时出错: ${e.message}`, botToken);
		}
	}
	return new Response('OK', { status: 200 });
}
/**
 * 发送消息到指定的 Telegram 聊天
 * @param {string | number} chatId 聊天 ID
 * @param {string} text 要发送的文本
 * @param {string} botToken 机器人 Token
 */
async function sendTelegramMessage(chatId, text, botToken) {
	const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
	const payload = {
		chat_id: chatId,
		text: text,
		parse_mode: 'Markdown' // 也可以使用 'HTML'
	};

	try {
		const response = await fetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json'
			},
			body: JSON.stringify(payload)
		});
		if (!response.ok) {
			const errorBody = await response.json();
			console.error(`Failed to send Telegram message: ${errorBody.description}`);
		}
	} catch (error) {
		console.error(`Error sending Telegram message: ${error.message}`);
	}
}


function extractImageUrls(content) {
	// 正则表达式：全局匹配所有 Markdown 图片语法 ![alt](url)
	// 关键点：
	// 1. /g flag - 确保能找到文中所有的图片，而不仅仅是第一个
	// 2. \!\[.*?\] - 非贪婪地匹配 alt 文本部分，处理各种复杂的 alt 内容
	// 3. \((.*?)\) - 捕获组( ... )，非贪婪地捕获括号内的 URL
	const regex = /!\[.*?\]\((.*?)\)/g;

	// 使用 String.prototype.matchAll() 来获取所有匹配项和捕获组
	// 它返回一个迭代器，我们用 Array.from 将其转换为数组
	const matches = Array.from(content.matchAll(regex));

	// 提取每个匹配项的第一个捕获组（也就是 URL）
	const urls = matches.map(match => match[1]);

	// 返回一个 JSON 字符串数组，以便直接存入 D1 的 TEXT 字段
	return JSON.stringify(urls);
}
/**
 * 处理笔记的标签逻辑，过滤掉 URL 中的 #
 */
async function processNoteTags(db, noteId, content) {
	const plainTextContent = content.replace(/<[^>]*>/g, '');
	// 1. 定义两个正则表达式：一个用于标签，一个用于 URL
	const tagRegex = /#([\p{L}\p{N}_-]+)/gu;
	const urlRegex = /(https?:\/\/[^\s"']*[^\s"'.?,!])/g;

	// 2. 将内容分割成“普通文本”和“链接文本”的交替数组
	const segments = plainTextContent.split(urlRegex);
	let allTags = [];

	// 3. 遍历所有片段
	segments.forEach(segment => {
		// 4. 关键：只在【非链接】的文本片段中查找标签
		//    我们通过重新测试来判断它是否是 URL
		if (!/^(https?:\/\/[^\s"']*[^\s"'.?,!])/.test(segment)) {
			const matchedInSegment = [...segment.matchAll(tagRegex)].map(match => match[1].toLowerCase());
			allTags.push(...matchedInSegment);
		}
	});

	// 5. 将从所有安全片段中找到的标签进行去重
	const uniqueTags = [...new Set(allTags)];

	const statements = [];
	statements.push(db.prepare("DELETE FROM note_tags WHERE note_id = ?").bind(noteId));

	if (uniqueTags.length > 0) {
		for (const tagName of uniqueTags) {
			await db.prepare("INSERT OR IGNORE INTO tags (name) VALUES (?)").bind(tagName).run();
			const tag = await db.prepare("SELECT id FROM tags WHERE name = ?").bind(tagName).first();
			if (tag) {
				statements.push(
					db.prepare("INSERT OR IGNORE INTO note_tags (note_id, tag_id) VALUES (?, ?)")
						.bind(noteId, tag.id)
				);
			}
		}
	}
	if (statements.length > 0) {
		await db.batch(statements);
	}
}
/**
 * 处理独立的图片上传请求 (从粘贴操作)
 * 改为上传到 GitHub 公开仓库，返回 jsDelivr 直链。
 */
async function handleStandaloneImageUpload(request, env, ctx) {
	try {
		const formData = await request.formData();
		const file = formData.get('file');

		if (!file || !file.name || file.size === 0) {
			return jsonResponse({ error: 'A file is required for upload.' }, 400);
		}

		// 上传到 GitHub，返回钉在 commit SHA 上的 jsDelivr 直链（立即可见）
		const media = await uploadFileToGithub(env, file);

		// 预热：触发 jsDelivr 首次回源，用户第一次打开不会慢
		if (ctx) {
			ctx.waitUntil(fetch(media.url, { method: 'GET' }).catch(() => {}));
		}

		return jsonResponse({
			success: true,
			url: media.url,
			fallbacks: media.fallbacks,
			path: media.path,
			name: media.name,
			size: media.size,
		});

	} catch (e) {
		console.error("Standalone Image Upload Error:", e.message);
		const status = typeof e.status === 'number' ? e.status : 500;
		return jsonResponse({ error: 'Upload failed', message: e.message }, status);
	}
}

async function handleGetAllAttachments(request, env) {
	const db = env.DB;
	const url = new URL(request.url);
	const page = parseInt(url.searchParams.get('page') || '1');
	const limit = 20; // 每次加载20条附件
	const offset = (page - 1) * limit;

	try {
		// 使用 Common Table Expression (CTE) 和 UNION ALL 来构建一个高效的单一查询
		const query = `
            WITH combined_attachments AS (
                SELECT
                    n.id AS noteId, n.updated_at AS timestamp, 'image' AS type,
                    json_each.value AS url, NULL AS name, NULL AS size, NULL AS id
                FROM notes n, json_each(n.pics) AS json_each
                WHERE json_valid(n.pics) AND json_array_length(n.pics) > 0

                UNION ALL

                SELECT
                    n.id AS noteId, n.updated_at AS timestamp, 'video' AS type,
                    json_each.value AS url, NULL AS name, NULL AS size, NULL AS id
                FROM notes n, json_each(n.videos) AS json_each
                WHERE json_valid(n.videos) AND json_array_length(n.videos) > 0

                UNION ALL

                SELECT
                    n.id AS noteId, n.updated_at AS timestamp, 'file' AS type,
                    NULL AS url, json_extract(json_each.value, '$.name') AS name,
                    json_extract(json_each.value, '$.size') AS size,
                    json_extract(json_each.value, '$.id') AS id
                FROM notes n, json_each(n.files) AS json_each
                WHERE json_valid(n.files) AND json_array_length(n.files) > 0
            )
            SELECT * FROM combined_attachments
            ORDER BY timestamp DESC
            LIMIT ? OFFSET ?;
        `;

		// 为了判断是否有更多页面，我们请求 limit + 1 条记录
		const stmt = db.prepare(query);
		const { results: attachmentsPlusOne } = await stmt.bind(limit + 1, offset).all();

		const hasMore = attachmentsPlusOne.length > limit;
		const attachments = attachmentsPlusOne.slice(0, limit);

		return jsonResponse({
			attachments: attachments,
			hasMore: hasMore
		});

	} catch (e) {
		console.error("Get All Attachments Error:", e.message);
		return jsonResponse({ error: 'Database Error', message: e.message }, 500);
	}
}

/**
 * 旧版内部图片路由 /api/images/:imageId。
 * 媒体已迁移到 GitHub + jsDelivr，不再由 Worker 代理读取，
 * 这里保留路由只是为了给历史链接一个明确回复，而不是抛异常。
 */
async function handleServeStandaloneImage(imageId, env) {
	return new Response(
		'该图片路径已废弃：媒体已迁移到 GitHub 公开仓库 + jsDelivr 直链。请重新上传图片。',
		{ status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
	);
}

/**
 * 为文件生成一个唯一的、可公开访问的链接。
 * POST /api/notes/:noteId/files/:fileId/share
 */
async function handleShareFileRequest(noteId, fileId, request, env) {
	const db = env.DB;
	const id = parseInt(noteId);
	if (isNaN(id)) {
		return new Response('Invalid Note ID', { status: 400 });
	}

	try {
		const note = await db.prepare("SELECT files FROM notes WHERE id = ?").bind(id).first();
		if (!note) {
			return jsonResponse({ error: 'Note not found' }, 404);
		}

		let files = [];
		try {
			if (typeof note.files === 'string') {
				files = JSON.parse(note.files);
			}
		} catch(e) { /* ignore */ }

		const fileIndex = files.findIndex(f => f.id === fileId);
		if (fileIndex === -1) {
			return jsonResponse({ error: 'File not found in this note' }, 404);
		}

		const file = files[fileIndex];
		let publicId = file.public_id;

		if (!publicId) {
			publicId = crypto.randomUUID();
			// 1. 在 KV 中存储映射关系，用于快速、免认证的查找
			await env.NOTES_KV.put(`public_file:${publicId}`, JSON.stringify({
				noteId: id,
				fileId: file.id,
				fileName: file.name,
				contentType: file.type,
				url: file.url // jsDelivr 直链，公开访问时直接跳转
			}));

			// 2. 将 public_id 持久化到 D1 数据库中
			files[fileIndex].public_id = publicId;
			await db.prepare("UPDATE notes SET files = ? WHERE id = ?").bind(JSON.stringify(files), id).run();
		}

		const { protocol, host } = new URL(request.url);
		const publicUrl = `${protocol}//${host}/api/public/file/${publicId}`;

		return jsonResponse({ url: publicUrl });
	} catch (e) {
		console.error(`Share File Error (noteId: ${noteId}, fileId: ${fileId}):`, e.message);
		return jsonResponse({ error: 'Database error while generating link', message: e.message }, 500);
	}
}

/**
 * 处理对公开文件链接的访问请求，无需身份验证。
 * GET /api/public/file/:publicId
 * 现在能同时处理笔记附件和独立上传的图片。
 */
async function handlePublicFileRequest(publicId, request, env) {
	const kvData = await env.NOTES_KV.get(`public_file:${publicId}`, 'json');
	if (!kvData) {
		return new Response('Public link not found or has expired.', { status: 404 });
	}

	// 分享链接只做跳转，字节流交给 jsDelivr
	const targetUrl = kvData.url;
	if (!targetUrl) {
		return new Response('Invalid public link data (missing url).', { status: 500 });
	}

	const headers = new Headers();
	headers.set('Location', targetUrl);
	headers.set('Cache-Control', 'public, max-age=86400');
	return new Response(null, { status: 302, headers });
}

/**
 * [认证] 处理创建或获取/更新 Memos 分享链接的请求
 * POST /api/notes/:noteId/share
 * Body (可选):
 * {
 *   "expirationTtl": 3600, // (in seconds) for initial creation or update
 *   "publicId": "some-uuid" // for updating TTL of an existing link
 * }
 */
async function handleShareNoteRequest(noteId, request, env) {
	try {
		const body = await request.json().catch(() => ({}));

		if (body.publicId && body.expirationTtl !== undefined) {
			const noteShareKey = `note_share:${noteId}`;
			const publicMemoKey = `public_memo:${body.publicId}`;

			// 为了安全，验证一下 publicId 是否真的属于这个 noteId
			const storedPublicId = await env.NOTES_KV.get(noteShareKey);
			if (storedPublicId !== body.publicId) {
				return jsonResponse({ error: 'Invalid public ID for this note.' }, 400);
			}

			// 获取旧值以便重新写入
			const memoData = await env.NOTES_KV.get(publicMemoKey);
			if (!memoData) {
				return jsonResponse({ error: 'Share link not found or already expired.' }, 404);
			}

			const options = {};
			if (body.expirationTtl > 0) {
				options.expirationTtl = body.expirationTtl;
			}
			// 如果 expirationTtl <= 0，则不设置 options.expirationTtl，KV 会将其视为永不过期

			// 使用新 TTL 重新写入两个键
			await Promise.all([
				env.NOTES_KV.put(publicMemoKey, memoData, options),
				env.NOTES_KV.put(noteShareKey, body.publicId, options)
			]);

			return jsonResponse({ success: true, message: 'Expiration updated.' });

		} else {
			// --- 创建或获取新链接 ---
			let publicId = await env.NOTES_KV.get(`note_share:${noteId}`);

			if (!publicId) {
				publicId = crypto.randomUUID();
				// 默认过期时间为 1 小时 (3600 秒)
				const expirationTtl = (body.expirationTtl !== undefined) ? body.expirationTtl : 3600;
				const options = {};
				if (expirationTtl > 0) {
					options.expirationTtl = expirationTtl;
				}

				await Promise.all([
					env.NOTES_KV.put(`public_memo:${publicId}`, JSON.stringify({ noteId: parseInt(noteId, 10) }), options),
					env.NOTES_KV.put(`note_share:${noteId}`, publicId, options)
				]);
			}

			const { protocol, host } = new URL(request.url);
			const displayUrl = `${protocol}//${host}/share/${publicId}`;
			const rawUrl = `${protocol}//${host}/api/public/note/raw/${publicId}`;

			return jsonResponse({ displayUrl, rawUrl, publicId }); // 返回 publicId 以便前端更新
		}
	} catch (e) {
		console.error(`Share/Update Note Error (noteId: ${noteId}):`, e.message);
		return jsonResponse({ error: 'Database or KV error during operation' }, 500);
	}
}

/**
 * 处理取消 Memos 分享的请求
 * DELETE /api/notes/:noteId/share
 */
async function handleUnshareNoteRequest(noteId, env) {
	try {
		const publicId = await env.NOTES_KV.get(`note_share:${noteId}`);
		if (publicId) {
			await Promise.all([
				env.NOTES_KV.delete(`public_memo:${publicId}`),
				env.NOTES_KV.delete(`note_share:${noteId}`)
			]);
		}
		return jsonResponse({ success: true, message: 'Sharing has been revoked.' });
	} catch (e) {
		console.error(`Unshare Note Error (noteId: ${noteId}):`, e.message);
		return jsonResponse({ error: 'Database error while revoking link' }, 500);
	}
}
/**
 * 处理对单个分享 Memos 内容的请求
 * GET /api/public/note/:publicId
 */
async function handlePublicNoteRequest(publicId, env) {
	const kvData = await env.NOTES_KV.get(`public_memo:${publicId}`, 'json');
	if (!kvData || !kvData.noteId) {
		return jsonResponse({ error: 'Shared note not found or has expired' }, 404);
	}

	const noteId = kvData.noteId;

	try {
		const note = await env.DB.prepare("SELECT id, content, updated_at, files FROM notes WHERE id = ?").bind(noteId).first();
		if (!note) {
			return jsonResponse({ error: 'Shared note content not found' }, 404);
		}

		// --- 辅助函数：将任何私有 URL 转换为公开 URL ---
		const createPublicUrlFor = async (privateUrl) => {
			const fileMatch = privateUrl.match(/^\/api\/files\/(\d+)\/([a-zA-Z0-9-]+)$/);
			const imageMatch = privateUrl.match(/^\/api\/images\/([a-zA-Z0-9-]+)$/);

			let kvPayload = null;
			if (fileMatch) {
				kvPayload = { noteId: parseInt(fileMatch[1]), fileId: fileMatch[2], fileName: 'media' };
			} else if (imageMatch) {
				kvPayload = { standaloneImageId: imageMatch[1], fileName: 'image.png' };
			}

			if (kvPayload) {
				const newPublicId = crypto.randomUUID();
				await env.NOTES_KV.put(`public_file:${newPublicId}`, JSON.stringify(kvPayload));
				return `/api/public/file/${newPublicId}`;
			}

			return privateUrl; // 如果不是私有链接，则原样返回
		};

		// 1. 处理笔记正文 `content` 中的内联图片和视频
		const urlRegex = /(\/api\/(?:files|images)\/[a-zA-Z0-9\/-]+)/g;
		const matches = [...note.content.matchAll(urlRegex)];
		let processedContent = note.content;
		for (const match of matches) {
			const privateUrl = match[0];
			const publicUrl = await createPublicUrlFor(privateUrl);
			processedContent = processedContent.replace(privateUrl, publicUrl);
		}
		note.content = processedContent;

		// 2. 处理 `files` 附件列表
		let files = [];
		if (typeof note.files === 'string') {
			try { files = JSON.parse(note.files); } catch (e) { /* an empty array is fine */ }
		}
		for (const file of files) {
			if (file.id) { // 只处理有 id 的内部文件
				const privateUrl = `/api/files/${note.id}/${file.id}`;
				// 复用上面的逻辑，但这次我们知道所有元数据
				const filePublicId = crypto.randomUUID();
				await env.NOTES_KV.put(`public_file:${filePublicId}`, JSON.stringify({
					noteId: note.id,
					fileId: file.id,
					fileName: file.name,
					contentType: file.type
				}));
				file.public_url = `/api/public/file/${filePublicId}`;
			}
		}
		note.files = files;

		// 3. 安全处理：移除敏感信息
		delete note.id;

		// `pics` 和 `videos` 字段的内容已经被处理并包含在 `content` 中，
		// 为保持 API 响应干净，我们不再需要它们。
		delete note.pics;
		delete note.videos;

		return jsonResponse(note);

	} catch (e) {
		console.error(`Public Note Error (publicId: ${publicId}):`, e.message);
		return jsonResponse({ error: 'Database Error' }, 500);
	}
}

/**
 * 处理对分享 Memos Raw 内容的请求
 * GET /api/public/note/raw/:publicId
 */
async function handlePublicRawNoteRequest(publicId, env) {
	// 1. 从 KV 获取 noteId
	const kvData = await env.NOTES_KV.get(`public_memo:${publicId}`, 'json');
	if (!kvData || !kvData.noteId) {
		return new Response('Not Found', { status: 404 });
	}

	try {
		// 2. 使用获取到的 noteId 从 D1 查询笔记内容
		const note = await env.DB.prepare("SELECT content FROM notes WHERE id = ?").bind(kvData.noteId).first();
		if (!note) {
			return new Response('Not Found', { status: 404 });
		}
		const headers = new Headers({ 'Content-Type': 'text/plain; charset=utf-8' });
		return new Response(note.content, { headers });
	} catch (e) {
		console.error(`Public Raw Note Error (publicId: ${publicId}):`, e.message);
		return new Response('Server Error', { status: 500 });
	}
}

/**
 * 处理笔记合并请求
 * POST /api/notes/merge
 * Body: { sourceNoteId: number, targetNoteId: number, addSeparator: boolean }
 */
async function handleMergeNotes(request, env) {
	const db = env.DB;
	try {
		const { sourceNoteId, targetNoteId, addSeparator } = await request.json();

		if (!sourceNoteId || !targetNoteId || sourceNoteId === targetNoteId) {
			return jsonResponse({ error: 'Invalid source or target note ID.' }, 400);
		}

		const [sourceNote, targetNote] = await Promise.all([
			db.prepare("SELECT * FROM notes WHERE id = ?").bind(sourceNoteId).first(),
			db.prepare("SELECT * FROM notes WHERE id = ?").bind(targetNoteId).first(),
		]);

		if (!sourceNote || !targetNote) {
			return jsonResponse({ error: 'One or both notes not found.' }, 404);
		}

		// 目标笔记在前，源笔记在后
		const separator = addSeparator ? '\n\n---\n\n' : '\n\n';
		const mergedContent = targetNote.content + separator + sourceNote.content;
		const targetFiles = JSON.parse(targetNote.files || '[]');
		const sourceFiles = JSON.parse(sourceNote.files || '[]');
		const mergedFiles = JSON.stringify([...targetFiles, ...sourceFiles]);

		const mergedTimestamp = targetNote.updated_at;

		// --- 数据库与 R2 操作 ---

		// 更新目标笔记
		const stmt = db.prepare(
			"UPDATE notes SET content = ?, files = ?, updated_at = ? WHERE id = ?"
		);
		await stmt.bind(mergedContent, mergedFiles, mergedTimestamp, targetNote.id).run();

		// 为更新后的目标笔记重新处理标签
		await processNoteTags(db, targetNote.id, mergedContent);

		// 删除源笔记
		await db.prepare("DELETE FROM notes WHERE id = ?").bind(sourceNote.id).run();

		// 文件本体现在是 jsDelivr 外链，与目标笔记 ID 无关，
		// 因此只需把 files 数组合并即可，无需搬运任何字节。

		// 合并 pics / videos（都是外链数组），避免源笔记删除后引用丢失
		const mergeUrls = (a, b) => {
			const parse = v => { try { return JSON.parse(v || '[]'); } catch { return []; } };
			return JSON.stringify([...new Set([...parse(a), ...parse(b)])]);
		};
		await db.prepare("UPDATE notes SET pics = ?, videos = ? WHERE id = ?")
			.bind(
				mergeUrls(targetNote.pics, sourceNote.pics),
				mergeUrls(targetNote.videos, sourceNote.videos),
				targetNote.id
			).run();

		// 返回更新后的目标笔记
		const updatedMergedNote = await db.prepare("SELECT * FROM notes WHERE id = ?").bind(targetNote.id).first();
		if (typeof updatedMergedNote.files === 'string') {
			updatedMergedNote.files = JSON.parse(updatedMergedNote.files);
		}

		return jsonResponse(updatedMergedNote);

	} catch (e) {
		console.error("Merge Notes Error:", e.message, e.cause);
		return jsonResponse({ error: 'Database error during merge', message: e.message }, 500);
	}
}

/**
 * 统一的 JSON 响应函数
 */
function jsonResponse(data, status = 200, headers = new Headers()) {
	headers.set('Content-Type', 'application/json');
	return new Response(JSON.stringify(data, null, 2), { status, headers });
}
