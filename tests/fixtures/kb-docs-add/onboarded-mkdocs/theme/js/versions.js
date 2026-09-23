// Fills the version picker from versions.json, published next to the docs.
(function () {
  var picker = document.getElementById('version-picker');
  if (!picker) return;

  fetch('versions.json')
    .then(function (r) { return r.json(); })
    .then(function (versions) {
      // The docs root is the first path segment of the current page.
      var root = '/' + location.pathname.split('/')[1] + '/';
      versions.forEach(function (v) {
        var option = document.createElement('option');
        option.value = root + v.path;
        option.textContent = v.title;
        picker.appendChild(option);
      });
    });

  picker.addEventListener('change', function () {
    location.href = picker.value;
  });
})();
