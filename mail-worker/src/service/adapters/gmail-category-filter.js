const DEFAULT_EXCLUDED_GMAIL_CATEGORIES = ['updates'];

function normalizeCategory(value) {
	let category = String(value || '').trim().toLowerCase();
	if (!category) {
		return '';
	}

	category = category
		.replace(/^gmail[\s:/_-]*category[\s:_-]*/i, '')
		.replace(/^category[\s:_-]*/i, '')
		.replace(/[^a-z0-9_-]/g, '');

	// Keep accepting the common typo used in run notes/UI comments.
	return category === 'updateds' ? 'updates' : category;
}

function normalizeCategoryList(value, fallback = DEFAULT_EXCLUDED_GMAIL_CATEGORIES) {
	if (value === false || value === null) {
		return [];
	}

	let items;
	if (Array.isArray(value)) {
		items = value;
	} else if (typeof value === 'string') {
		const trimmed = value.trim();
		if (!trimmed) {
			items = fallback;
		} else if (/^(?:0|false|no|none|off)$/i.test(trimmed)) {
			return [];
		} else {
			items = trimmed.split(/[\s,]+/);
		}
	} else if (value === undefined) {
		items = fallback;
	} else {
		items = [value];
	}

	return [...new Set(
		items
			.map(normalizeCategory)
			.filter(Boolean)
			.filter(category => !/^(?:0|false|no|none|off)$/.test(category)),
	)];
}

function escapeRegExp(value) {
	return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function excludedGmailCategories(metadata = {}) {
	return normalizeCategoryList(
		metadata.excludeGmailCategories
			?? metadata.gmailExcludeCategories
			?? metadata.excludedGmailCategories
			?? metadata.excludeCategories,
	);
}

export function gmailExclusionQuery(categories) {
	return normalizeCategoryList(categories, [])
		.map(category => `-category:${category}`)
		.join(' ');
}

export function hasExcludedGmailCategoryLabel(fetchText, categories) {
	const normalizedCategories = normalizeCategoryList(categories, []);
	if (!normalizedCategories.length) {
		return false;
	}

	const lowerText = String(fetchText || '').toLowerCase();
	const labelBlocks = [...lowerText.matchAll(/x-gm-labels\s*\(([^)]*)\)/g)]
		.map(match => match[1]);
	const labelText = labelBlocks.length ? labelBlocks.join(' ') : lowerText;

	return normalizedCategories.some((category) => {
		const escaped = escapeRegExp(category);
		return new RegExp(`(?:category[\\s:_-]*${escaped}|\\\\category[\\s:_-]*${escaped}|\\b${escaped}\\b)`, 'i')
			.test(labelText);
	});
}
