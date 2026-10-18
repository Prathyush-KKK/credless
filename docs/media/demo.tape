# vhs tape for the README GIF (GTM plan §5): 20 seconds, under 4 MB, ends on the red line.
#   vhs docs/media/demo.tape   (https://github.com/charmbracelet/vhs)
# Record in a checkout where `pnpm build` ran and the demo passes. The second half needs `credless demo --plant-secret`
# (planned); until it exists, record the first half only and cut at the SUMMARY line.
Output docs/media/demo.gif

Set Shell "bash"
Set FontSize 16
Set Width 1200
Set Height 640
Set Theme "Catppuccin Mocha"
Set TypingSpeed 40ms
Set Framerate 20

Type "npx credless demo"
Sleep 500ms
Enter
# the demo app starts, three browser tiles labelled owner / member / guest, the contact sheet fills in
Sleep 7s
Type "npx credless report summary $(ls -t apps/demo/reports | head -1) | head -12"
Enter
# "12 passed · 0 flaky · leak scan clean"
Sleep 4s
Type "npx credless demo --plant-secret"
Sleep 500ms
Enter
# red: "secret value found in evidence, run failed, staging deleted"; end on that line
Sleep 7s
