document.querySelectorAll('.listing-thumbnail').forEach(button => {
    button.addEventListener('click', () => {
        const mainImage = document.getElementById('mainListingImage');

        mainImage.src = button.dataset.image;

        document.querySelectorAll('.listing-thumbnail').forEach(item => {
            item.classList.remove('active');
            item.setAttribute('aria-pressed', 'false');
        });

        button.classList.add('active');
        button.setAttribute('aria-pressed', 'true');
    });
});
