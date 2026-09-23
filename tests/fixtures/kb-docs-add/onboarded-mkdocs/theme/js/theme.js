// Dark-mode toggle for the standalone site.
document.getElementById('theme-toggle').addEventListener('click', function () {
  var dark = document.documentElement.classList.toggle('dark');
  localStorage.setItem('theme', dark ? 'dark' : 'light');
});
