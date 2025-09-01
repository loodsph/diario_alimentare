export function showToast(message, isError = false) {
    const toast = document.getElementById('toast');
    const iconContainer = toast.querySelector('div');
    const icon = toast.querySelector('i');
    const text = toast.querySelector('span');

    text.textContent = message;

    if (isError) {
        iconContainer.className = 'w-8 h-8 rounded-full bg-gradient-to-r from-red-500 to-pink-500 flex items-center justify-center';
        icon.className = 'fas fa-exclamation-circle text-white text-sm';
    } else {
        iconContainer.className = 'w-8 h-8 rounded-full bg-gradient-to-r from-green-400 to-emerald-500 flex items-center justify-center';
        icon.className = 'fas fa-check text-white text-sm';
    }

    toast.classList.remove('opacity-0', 'translate-y-10');

    setTimeout(() => {
        toast.classList.add('opacity-0', 'translate-y-10');
    }, 3000);
}

export function triggerFlashAnimation(elementId) {
    const element = document.getElementById(elementId);
    if (element) {
        element.classList.add('flash-update');
        element.addEventListener('animationend', () => {
            element.classList.remove('flash-update');
        }, { once: true });
    }
}