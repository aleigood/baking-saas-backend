(function (window) {
    const normalizeName = (value) =>
        String(value || '')
            .normalize('NFKC')
            .trim();

    const keyOf = (value) =>
        normalizeName(value)
            .replace(/[\s·・_-]+/g, '')
            .toLocaleLowerCase('zh-CN');

    const toNumber = (value, fallback = 0) => {
        const parsed = Number(value);

        return Number.isFinite(parsed) ? parsed : fallback;
    };

    const asArray = (value) => (Array.isArray(value) ? value : []);

    const clone = (value) => JSON.parse(JSON.stringify(value || {}));

    const hasValue = (value) => value !== undefined && value !== null && value !== '';

    const flourPattern = /(粉|面粉|高筋|低筋|中筋|法粉|T\d+|百合花|昭和|拿破仑|鹰牌|山茶花|霓虹|柔风)/i;

    const selfMadePattern = /(种|酱|馅|泥|膏|馅料|夹心|夹馅|奶酥|酥粒|汤种|烫种|中种|鲁邦|老面|波兰种|液种|装饰)/;

    const preDoughPattern = /(种|汤种|烫种|中种|鲁邦|老面|波兰种|液种)/;

    function catalogMap(catalogItems) {
        const map = new Map();

        asArray(catalogItems).forEach((item) => {
            const name = normalizeName(item?.name || item);

            if (!name) return;

            map.set(keyOf(name), {
                name,

                isFlour: !!item?.isFlour,

                waterContent: toNumber(item?.waterContent, 0),
            });
        });

        return map;
    }

    function collectSelfMadeNames(result) {
        const names = new Set();

        asArray(result?.recipes).forEach((recipe) => {
            const name = normalizeName(recipe?.name);

            if (name && recipe?.type !== 'MAIN') names.add(keyOf(name));
        });

        return names;
    }

    function inferDecision(sourceName, finalName, matchedCatalog, selfMadeNames) {
        if (selfMadeNames.has(keyOf(finalName)) || selfMadeNames.has(keyOf(sourceName))) return 'SELF_MADE';

        if (matchedCatalog) return 'MATCH_EXISTING';

        if (selfMadePattern.test(finalName) && !flourPattern.test(finalName)) return 'SELF_MADE';

        return 'NEW_BASE';
    }

    function inferWaterContentPercent(name, matchedCatalog) {
        if (matchedCatalog) return Math.round(toNumber(matchedCatalog.waterContent, 0) * 10000) / 100;

        if (/水$|^水$|后加水|冰水|热水|开水/.test(name)) return 100;

        if (/牛奶|淡奶|奶油|番茄汁|果汁/.test(name)) return 0;

        return 0;
    }

    function collectIngredientCandidates(result) {
        const fromModel = asArray(result?.ingredients);

        if (fromModel.length) return fromModel;

        const collected = new Map();

        walkIngredients(result, (ingredient, recipe, _version, section, product) => {
            const sourceName = normalizeName(ingredient?.name);

            if (!sourceName) return;

            const key = keyOf(sourceName);

            const usage = [recipe?.name, product?.name, section].filter(Boolean).join(' / ');

            const existing = collected.get(key);

            if (existing) {
                existing.occurrenceCount++;

                if (usage && !existing.usages.includes(usage)) existing.usages.push(usage);

                return;
            }

            collected.set(key, {
                sourceName,

                normalizedName: sourceName,

                status: 'NEW',

                occurrenceCount: 1,

                usages: usage ? [usage] : [],
            });
        });

        return Array.from(collected.values());
    }

    function createIngredientReviewItems(result, catalogItems) {
        const catalog = catalogMap(catalogItems);

        const selfMadeNames = collectSelfMadeNames(result);

        return collectIngredientCandidates(result).map((ingredient, index) => {
            const sourceName = normalizeName(
                ingredient?.sourceName || ingredient?.normalizedName || `原料${index + 1}`,
            );

            const normalizedName = normalizeName(ingredient?.normalizedName || sourceName);

            const matchedCatalog = catalog.get(keyOf(normalizedName)) || catalog.get(keyOf(sourceName));

            const finalName = matchedCatalog?.name || normalizedName || sourceName;

            const decision = inferDecision(sourceName, finalName, matchedCatalog, selfMadeNames);

            const needsReview =
                ingredient?.status === 'REVIEW' ||
                decision === 'SELF_MADE' ||
                (!matchedCatalog && ingredient?.status !== 'MATCHED') ||
                sourceName !== finalName;

            return {
                id: `ingredient-review-${index}-${keyOf(sourceName) || index}`,

                sourceName,

                normalizedName,

                finalName,

                decision,

                isFlour: matchedCatalog ? matchedCatalog.isFlour : flourPattern.test(finalName),

                waterContentPercent: inferWaterContentPercent(finalName, matchedCatalog),

                occurrenceCount: ingredient?.occurrenceCount || 1,

                usages: asArray(ingredient?.usages),

                status: needsReview ? 'PENDING' : 'CONFIRMED',

                originalStatus: ingredient?.status || 'NEW',
            };
        });
    }

    function walkIngredients(result, visitor) {
        asArray(result?.recipes).forEach((recipe) => {
            asArray(recipe?.versions).forEach((version) => {
                asArray(version?.ingredients).forEach((ingredient) =>
                    visitor(ingredient, recipe, version, 'ingredients'),
                );

                asArray(version?.products).forEach((product) => {
                    asArray(product?.mixIn).forEach((ingredient) =>
                        visitor(ingredient, recipe, version, 'mixIn', product),
                    );

                    asArray(product?.mixIns).forEach((ingredient) =>
                        visitor(ingredient, recipe, version, 'mixIns', product),
                    );

                    asArray(product?.fillings).forEach((ingredient) =>
                        visitor(ingredient, recipe, version, 'fillings', product),
                    );

                    asArray(product?.toppings).forEach((ingredient) =>
                        visitor(ingredient, recipe, version, 'toppings', product),
                    );
                });
            });
        });
    }

    function mergeIngredientList(items) {
        const merged = new Map();

        asArray(items).forEach((item) => {
            const name = normalizeName(item?.name);

            if (!name) return;

            const amountKind = hasValue(item.flourRatio)
                ? 'flourRatio'
                : hasValue(item.weightInGrams)
                  ? 'weightInGrams'
                  : 'ratio';

            const key = `${keyOf(name)}::${amountKind}::${item.recipeVersionId || ''}`;

            const existing = merged.get(key);

            if (!existing) {
                merged.set(key, { ...item, name });

                return;
            }

            ['ratio', 'flourRatio', 'weightInGrams'].forEach((field) => {
                if (hasValue(item[field]) || hasValue(existing[field])) {
                    existing[field] = toNumber(existing[field], 0) + toNumber(item[field], 0);
                }
            });

            existing.isFlour = existing.isFlour || item.isFlour;

            existing.waterContent = Math.max(toNumber(existing.waterContent, 0), toNumber(item.waterContent, 0));
        });

        return Array.from(merged.values());
    }

    function mergeDuplicateIngredients(result) {
        asArray(result?.recipes).forEach((recipe) => {
            asArray(recipe?.versions).forEach((version) => {
                version.ingredients = mergeIngredientList(version.ingredients);

                asArray(version?.products).forEach((product) => {
                    product.mixIn = mergeIngredientList(product.mixIn);

                    product.mixIns = mergeIngredientList(product.mixIns);

                    product.fillings = mergeIngredientList(product.fillings);

                    product.toppings = mergeIngredientList(product.toppings);
                });
            });
        });
    }

    function createSelfMadeRecipe(name, reviewItem) {
        const recipeType = preDoughPattern.test(name) ? 'PRE_DOUGH' : 'EXTRA';

        return {
            name,

            type: recipeType,

            category: 'OTHER',

            versions: [
                {
                    notes: '智能导入创建的自制原料草稿，请补充配方比例。',

                    customWaterContent: toNumber(reviewItem.waterContentPercent, 0) / 100,

                    ingredients: [],

                    procedure: [''],
                },
            ],
        };
    }

    function summarizeIngredients(result, reviewItems) {
        const byName = new Map();

        const reviewByFinalName = new Map(reviewItems.map((item) => [keyOf(item.finalName), item]));

        walkIngredients(result, (ingredient, recipe, _version, section, product) => {
            const name = normalizeName(ingredient?.name);

            if (!name) return;

            const key = keyOf(name);

            const existing = byName.get(key);

            const usage = [recipe?.name, product?.name, section].filter(Boolean).join(' / ');

            if (existing) {
                existing.occurrenceCount++;

                if (usage && !existing.usages.includes(usage)) existing.usages.push(usage);

                return;
            }

            const reviewItem = reviewByFinalName.get(key);

            byName.set(key, {
                sourceName: reviewItem?.sourceName || name,

                normalizedName: name,

                status: reviewItem?.decision === 'MATCH_EXISTING' ? 'MATCHED' : 'NEW',

                usages: usage ? [usage] : [],

                occurrenceCount: 1,
            });
        });

        return Array.from(byName.values());
    }

    function isAmountOrRatioReviewItem(item) {
        const text = `${item?.label || ''}${item?.reason || ''}${item?.fieldPath || ''}`;

        return /用量|比例|克重|重量|amount|ratio|weight/i.test(text);
    }

    function isSecondaryIntermediateAmountReviewItem(result, item) {
        const fieldPath = String(item?.fieldPath || '');

        const match = fieldPath.match(/intermediateRecipes(?:\.|\[)(\d+)\]?\.(?:sections)(?:\.|\[)(\d+)\]?/);

        if (!match) return false;

        const recipeIndex = Number(match[1]);

        const sectionIndex = Number(match[2]);

        const intermediateRecipes = asArray(result?.diagnostics?.intermediateResult?.intermediateRecipes);

        const section = asArray(intermediateRecipes[recipeIndex]?.sections)[sectionIndex];

        if (!section || !['FILLING', 'TOPPING', 'EXTRA'].includes(String(section.kind || ''))) return false;

        const text = `${item?.label || ''}${item?.reason || ''}${item?.fieldPath || ''}`;

        return /用量|数量|克重|重量|单位|转换为g|amount|ratio|weight/i.test(text);
    }

    function pruneResolvedIngredientNameReviewItems(result, reviewItems) {
        const decisions = asArray(reviewItems);

        if (!decisions.length) return asArray(result?.reviewItems);

        const resolvedNames = new Set();

        decisions.forEach((item) => {
            [item.sourceName, item.normalizedName, item.finalName].forEach((name) => {
                const key = keyOf(name);

                if (key) resolvedNames.add(key);
            });
        });

        return asArray(result?.reviewItems).filter((item) => {
            if (isSecondaryIntermediateAmountReviewItem(result, item)) return false;

            if (isAmountOrRatioReviewItem(item)) return true;

            const fieldPath = String(item?.fieldPath || '');

            const text = `${item?.label || ''}${item?.reason || ''}`;

            const looksLikeIngredientName =
                /\.ingredients\.\d+\.name$/.test(fieldPath) ||
                /\.mixIn\.\d+\.name$/.test(fieldPath) ||
                /\.mixIns\.\d+\.name$/.test(fieldPath) ||
                /\.fillings\.\d+\.name$/.test(fieldPath) ||
                /\.toppings\.\d+\.name$/.test(fieldPath) ||
                /未标准化|已标准化为/.test(text) ||
                (/原料/.test(text) && /名称|确认|统一|规范|映射|未知/.test(text) && !/缺失|列表/.test(text)) ||
                (/面粉/.test(text) && /名称|确认|统一|规范|映射/.test(text));

            if (!looksLikeIngredientName) return true;

            if (/未知原料|面粉名称/.test(text)) return false;

            const recognizedKey = keyOf(item?.recognizedValue);

            const normalizedKey = keyOf(item?.normalizedValue);

            const itemHasConcreteName = Boolean(recognizedKey || normalizedKey);

            if (!itemHasConcreteName) return false;

            return !(resolvedNames.has(recognizedKey) || resolvedNames.has(normalizedKey));
        });
    }

    function applyIngredientReview(result, reviewItems) {
        const next = clone(result);

        const decisions = new Map();

        asArray(reviewItems).forEach((item) => {
            const sourceNames = [item.sourceName, item.normalizedName].map(normalizeName).filter(Boolean);

            sourceNames.forEach((name) => {
                decisions.set(keyOf(name), item);
            });
        });

        walkIngredients(next, (ingredient) => {
            const decision = decisions.get(keyOf(ingredient?.name));

            if (!decision) return;

            ingredient.name = normalizeName(decision.finalName || decision.sourceName);

            ingredient.isFlour = !!decision.isFlour;

            ingredient.waterContent = toNumber(decision.waterContentPercent, 0) / 100;
        });

        const existingSelfMade = collectSelfMadeNames(next);

        asArray(reviewItems).forEach((item) => {
            const finalName = normalizeName(item.finalName);

            if (!finalName || item.decision !== 'SELF_MADE' || existingSelfMade.has(keyOf(finalName))) return;

            next.recipes = asArray(next.recipes);

            next.recipes.push(createSelfMadeRecipe(finalName, item));

            existingSelfMade.add(keyOf(finalName));

            next.reviewItems = asArray(next.reviewItems);

            next.reviewItems.push({
                recipeName: finalName,

                fieldPath: 'versions.0.ingredients',

                label: `${finalName}配方`,

                severity: 'REVIEW',

                recognizedValue: item.sourceName,

                normalizedValue: finalName,

                reason: '已作为自制原料创建草稿，请补充这个自制原料的配方比例。',
            });
        });

        mergeDuplicateIngredients(next);

        next.ingredients = summarizeIngredients(next, asArray(reviewItems));

        next.reviewItems = pruneResolvedIngredientNameReviewItems(next, reviewItems);

        next.meta = { ...(next.meta || {}), ingredientReviewApplied: true };

        return next;
    }

    window.RecipeImportReview = {
        createIngredientReviewItems,

        applyIngredientReview,
    };
})(window);
