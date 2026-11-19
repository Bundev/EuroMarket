
INSERT INTO countries (code, name, currency, language)
VALUES
('DE', 'Германия', 'EUR', 'de'),
('PL', 'Польша', 'PLN', 'pl'),
('FR', 'Франция', 'EUR', 'fr'),
('ES', 'Испания', 'EUR', 'es'),
('IT', 'Италия', 'EUR', 'it'),
('NL', 'Нидерланды', 'EUR', 'nl'),
('CZ', 'Чехия', 'CZK', 'cs'),
('AT', 'Австрия', 'EUR', 'de'),
('BE', 'Бельгия', 'EUR', 'nl'),
('UA', 'Украина', 'UAH', 'uk')
ON DUPLICATE KEY UPDATE
    name = VALUES(name),
    currency = VALUES(currency),
    language = VALUES(language);


INSERT INTO categories (slug, name, icon)
VALUES
('vehicles', 'Автомобили', '🚗'),
('real-estate', 'Недвижимость', '🏠'),
('jobs', 'Работа', '💼'),
('electronics', 'Электроника', '📱'),
('home-garden', 'Дом и сад', '🛋️'),
('fashion', 'Одежда', '👕'),
('services', 'Услуги', '🔧'),
('kids', 'Детские товары', '🧸')
ON DUPLICATE KEY UPDATE
    name = VALUES(name),
    icon = VALUES(icon);
