Pod::Spec.new do |s|
  s.name           = 'MonacoCaretPosition'
  s.version        = '0.1.0'
  s.summary        = 'Caret rectangle lookup for Monaco Notepad mobile editor'
  s.description    = 'Returns native multiline TextInput caret coordinates for editor scroll positioning.'
  s.author         = 'Monaco Notepad'
  s.homepage       = 'https://github.com/'
  s.platforms      = { :ios => '15.1' }
  s.source         = { :git => '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.source_files = 'ios/**/*.{h,m,mm,swift}'
end
