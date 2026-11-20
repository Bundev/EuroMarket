for (const section of document.querySelectorAll('[data-attribute-fields]')) {
    const output = section.querySelector('[data-attribute-current]');
    const select = document.getElementById(section.dataset.categorySelect);
    const templates = [...section.querySelectorAll('template')];
    let current;
    function render() {
        const categoryId = select?.value ?? section.dataset.categoryId;
        const template = templates.find(item => item.dataset.categoryIds.split(',').includes(categoryId));
        if (current === template) return;
        current = template;
        output.replaceChildren();
        if (template) output.append(template.content.cloneNode(true));
    }
    select?.addEventListener('change', render);
    render();
}
