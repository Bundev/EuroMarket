// SQL expressions are supplied by callers, never by HTTP input.
const { savedFilters } = require('../services/listingAttributes');

function matchesAttributes(json) {
    return `NOT EXISTS (
        SELECT 1 FROM JSON_TABLE(${json}, '$[*]' COLUMNS (
            field_key VARCHAR(40) PATH '$.key',
            minimum DECIMAL(12,2) PATH '$.min',
            maximum DECIMAL(12,2) PATH '$.max',
            choices JSON PATH '$.values'
        )) af
        WHERE NOT EXISTS (
            SELECT 1 FROM listing_attributes a WHERE a.listing_id=l.id AND a.field_key=af.field_key
              AND ((af.choices IS NULL AND a.number_value IS NOT NULL
                    AND (af.minimum IS NULL OR a.number_value>=af.minimum)
                    AND (af.maximum IS NULL OR a.number_value<=af.maximum))
                OR (af.choices IS NOT NULL AND EXISTS (
                    SELECT 1 FROM JSON_TABLE(af.choices, '$[*]' COLUMNS (choice VARCHAR(100) PATH '$')) ac
                    WHERE BINARY a.text_value=BINARY ac.choice
                )))
        ) AND NOT (
            af.field_key='condition'
            AND NOT EXISTS (SELECT 1 FROM listing_attributes a WHERE a.listing_id=l.id AND a.field_key='condition')
            AND EXISTS (SELECT 1 FROM JSON_TABLE(af.choices, '$[*]' COLUMNS (choice VARCHAR(100) PATH '$')) ac
                        WHERE BINARY l.item_condition=BINARY ac.choice)
        )
    )`;
}

function validatedSearches(rows, categories) {
    return JSON.stringify(rows.flatMap(row => {
        try {
            return [{ id: row.id, filters: savedFilters(row.category_id, categories, row.attribute_query).constraints }];
        } catch { return []; }
    }));
}

const matchesSavedAttributes = `(s.attribute_query IS NULL OR EXISTS (
    SELECT 1 FROM JSON_TABLE(?, '$[*]' COLUMNS (
        search_id DECIMAL(20,0) PATH '$.id', constraints JSON PATH '$.filters'
    )) sa WHERE sa.search_id=s.id AND ${matchesAttributes('sa.constraints')}
))`;

module.exports = { matchesAttributes, matchesSavedAttributes, validatedSearches };
