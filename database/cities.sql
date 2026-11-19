
-- Города Украины
INSERT INTO cities (country_id, name, is_active)
SELECT id, 'Киев', 1 FROM countries WHERE code = 'UA'
UNION ALL
SELECT id, 'Одесса', 1 FROM countries WHERE code = 'UA'
UNION ALL
SELECT id, 'Львов', 1 FROM countries WHERE code = 'UA'
UNION ALL
SELECT id, 'Харьков', 1 FROM countries WHERE code = 'UA'
UNION ALL
SELECT id, 'Днепр', 1 FROM countries WHERE code = 'UA';

-- Города Германии
INSERT INTO cities (country_id, name, is_active)
SELECT id, 'Берлин', 1 FROM countries WHERE code = 'DE'
UNION ALL
SELECT id, 'Мюнхен', 1 FROM countries WHERE code = 'DE'
UNION ALL
SELECT id, 'Гамбург', 1 FROM countries WHERE code = 'DE'
UNION ALL
SELECT id, 'Франкфурт', 1 FROM countries WHERE code = 'DE'
UNION ALL
SELECT id, 'Кёльн', 1 FROM countries WHERE code = 'DE';

-- Города Польши
INSERT INTO cities (country_id, name, is_active)
SELECT id, 'Варшава', 1 FROM countries WHERE code = 'PL'
UNION ALL
SELECT id, 'Краков', 1 FROM countries WHERE code = 'PL'
UNION ALL
SELECT id, 'Вроцлав', 1 FROM countries WHERE code = 'PL'
UNION ALL
SELECT id, 'Гданьск', 1 FROM countries WHERE code = 'PL'
UNION ALL
SELECT id, 'Познань', 1 FROM countries WHERE code = 'PL';

-- Города Франции
INSERT INTO cities (country_id, name, is_active)
SELECT id, 'Париж', 1 FROM countries WHERE code = 'FR'
UNION ALL
SELECT id, 'Лион', 1 FROM countries WHERE code = 'FR'
UNION ALL
SELECT id, 'Марсель', 1 FROM countries WHERE code = 'FR';

-- Города Испании
INSERT INTO cities (country_id, name, is_active)
SELECT id, 'Мадрид', 1 FROM countries WHERE code = 'ES'
UNION ALL
SELECT id, 'Барселона', 1 FROM countries WHERE code = 'ES'
UNION ALL
SELECT id, 'Валенсия', 1 FROM countries WHERE code = 'ES';

-- Города Италии
INSERT INTO cities (country_id, name, is_active)
SELECT id, 'Рим', 1 FROM countries WHERE code = 'IT'
UNION ALL
SELECT id, 'Милан', 1 FROM countries WHERE code = 'IT'
UNION ALL
SELECT id, 'Неаполь', 1 FROM countries WHERE code = 'IT';

-- Города Нидерландов
INSERT INTO cities (country_id, name, is_active)
SELECT id, 'Амстердам', 1 FROM countries WHERE code = 'NL'
UNION ALL
SELECT id, 'Роттердам', 1 FROM countries WHERE code = 'NL'
UNION ALL
SELECT id, 'Гаага', 1 FROM countries WHERE code = 'NL';

-- Города Чехии
INSERT INTO cities (country_id, name, is_active)
SELECT id, 'Прага', 1 FROM countries WHERE code = 'CZ'
UNION ALL
SELECT id, 'Брно', 1 FROM countries WHERE code = 'CZ';

-- Города Австрии
INSERT INTO cities (country_id, name, is_active)
SELECT id, 'Вена', 1 FROM countries WHERE code = 'AT'
UNION ALL
SELECT id, 'Грац', 1 FROM countries WHERE code = 'AT';

-- Города Бельгии
INSERT INTO cities (country_id, name, is_active)
SELECT id, 'Брюссель', 1 FROM countries WHERE code = 'BE'
UNION ALL
SELECT id, 'Антверпен', 1 FROM countries WHERE code = 'BE';
