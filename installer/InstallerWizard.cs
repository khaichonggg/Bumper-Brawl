using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Reflection;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;
using System.Runtime.InteropServices;

[assembly: AssemblyTitle("Bumper Brawl Setup")]
[assembly: AssemblyDescription("Bumper Brawl Windows installer")]
[assembly: AssemblyCompany("Bumper Brawl")]
[assembly: AssemblyProduct("Bumper Brawl")]
[assembly: AssemblyVersion("2.6.2.0")]
[assembly: AssemblyFileVersion("2.6.2.0")]

internal static class InstallerWizard
{
    [STAThread]
    private static void Main()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new SetupForm());
    }
}

internal sealed class SetupForm : Form
{
    private readonly Panel brand = new Panel();
    private readonly Panel right = new Panel();
    private readonly Panel content = new Panel();
    private readonly Panel progress = new Panel();
    private readonly Label stepLabel = new Label();
    private readonly Label brandStatus = new Label();
    private readonly Button closeButton = new Button();
    private readonly ActionButton backButton = new ActionButton(false);
    private readonly ActionButton nextButton = new ActionButton(true);
    private string installPath;
    private TextBox pathBox;
    private bool installing;
    private int page;

    private static readonly Color Ink = Color.FromArgb(32, 31, 36);
    private static readonly Color Muted = Color.FromArgb(112, 109, 119);
    private static readonly Color Accent = Color.FromArgb(103, 87, 222);

    [DllImport("user32.dll")]
    private static extern bool ReleaseCapture();
    [DllImport("user32.dll")]
    private static extern IntPtr SendMessage(IntPtr hWnd, int message, IntPtr wParam, IntPtr lParam);

    public SetupForm()
    {
        Text = "Bumper Brawl Setup";
        ClientSize = new Size(920, 600);
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.CenterScreen;
        MinimumSize = MaximumSize = Size;
        BackColor = Color.White;
        ShowInTaskbar = true;
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer, true);

        brand.SetBounds(0, 0, 336, ClientSize.Height);
        brand.Anchor = AnchorStyles.Top | AnchorStyles.Bottom | AnchorStyles.Left;
        brand.Paint += PaintBrand;
        brand.MouseDown += DragWindow;
        Controls.Add(brand);

        right.SetBounds(336, 0, ClientSize.Width - 336, ClientSize.Height);
        right.Anchor = AnchorStyles.Top | AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right;
        right.BackColor = Color.White;
        right.MouseDown += DragWindow;
        Controls.Add(right);

        stepLabel.SetBounds(40, 22, 360, 20);
        stepLabel.Font = new Font("Segoe UI", 8.5F, FontStyle.Bold);
        stepLabel.ForeColor = Muted;
        stepLabel.MouseDown += DragWindow;
        right.Controls.Add(stepLabel);

        closeButton.SetBounds(right.Width - 46, 12, 34, 34);
        closeButton.Anchor = AnchorStyles.Top | AnchorStyles.Right;
        closeButton.Text = "×";
        closeButton.Font = new Font("Segoe UI Light", 19F);
        closeButton.ForeColor = Color.FromArgb(123, 120, 128);
        closeButton.BackColor = Color.White;
        closeButton.FlatStyle = FlatStyle.Flat;
        closeButton.FlatAppearance.BorderSize = 0;
        closeButton.Cursor = Cursors.Hand;
        closeButton.Click += delegate { Close(); };
        right.Controls.Add(closeButton);

        Panel track = new Panel();
        track.SetBounds(40, 58, right.Width - 80, 3);
        track.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
        track.BackColor = Color.FromArgb(239, 237, 243);
        right.Controls.Add(track);
        progress.BackColor = Accent;
        progress.SetBounds(0, 0, 0, 3);
        track.Controls.Add(progress);

        content.SetBounds(40, 89, right.Width - 80, 412);
        content.Anchor = AnchorStyles.Top | AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right;
        content.BackColor = Color.White;
        right.Controls.Add(content);

        Panel footerLine = new Panel();
        footerLine.SetBounds(40, 516, right.Width - 80, 1);
        footerLine.Anchor = AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right;
        footerLine.BackColor = Color.FromArgb(239, 237, 243);
        right.Controls.Add(footerLine);

        backButton.SetBounds(40, 535, 112, 44);
        backButton.Anchor = AnchorStyles.Bottom | AnchorStyles.Left;
        backButton.Text = "Back";
        backButton.Click += delegate { ShowPage(page == 5 ? 2 : Math.Max(0, page - 1)); };
        right.Controls.Add(backButton);

        nextButton.SetBounds(right.Width - 204, 535, 164, 44);
        nextButton.Anchor = AnchorStyles.Bottom | AnchorStyles.Right;
        nextButton.Text = "Continue";
        nextButton.Click += NextClicked;
        right.Controls.Add(nextButton);

        brandStatus.SetBounds(32, 536, 270, 22);
        brandStatus.Anchor = AnchorStyles.Bottom | AnchorStyles.Left;
        brandStatus.BackColor = Color.Transparent;
        brandStatus.Font = new Font("Segoe UI", 8.5F, FontStyle.Regular);
        brandStatus.ForeColor = Color.FromArgb(118, 111, 137);
        brand.Controls.Add(brandStatus);

        Shown += delegate { ShowPage(0); };
        FormClosing += delegate(object sender, FormClosingEventArgs e) { if (installing) e.Cancel = true; };
    }

    protected override CreateParams CreateParams
    {
        get { CreateParams cp = base.CreateParams; cp.ClassStyle |= 0x00020000; return cp; }
    }

    private void DragWindow(object sender, MouseEventArgs e)
    {
        if (e.Button == MouseButtons.Left) { ReleaseCapture(); SendMessage(Handle, 0xA1, (IntPtr)2, IntPtr.Zero); }
    }

    private void PaintBrand(object sender, PaintEventArgs e)
    {
        Graphics g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        using (LinearGradientBrush bg = new LinearGradientBrush(brand.ClientRectangle,
            Color.FromArgb(249, 247, 255), Color.FromArgb(240, 237, 251), 90F))
            g.FillRectangle(bg, brand.ClientRectangle);

        DrawBall(g, 35, 34, 20, Color.FromArgb(166, 145, 255), Color.FromArgb(104, 83, 220));
        DrawBall(g, 48, 42, 12, Color.FromArgb(255, 187, 159), Color.FromArgb(238, 124, 116));
        using (Font f = new Font("Segoe UI", 13F, FontStyle.Bold))
        using (SolidBrush b = new SolidBrush(Ink)) g.DrawString("Bumper Brawl", f, b, 68, 32);
        using (Font f = new Font("Segoe UI", 8F, FontStyle.Bold))
        using (SolidBrush b = new SolidBrush(Color.FromArgb(130, 124, 148)))
            g.DrawString("WINDOWS SETUP  ·  2.6.2", f, b, 36, 69);

        // Abstract bumper spheres echo the game without mascots or cartoon faces.
        DrawBall(g, 64, 224, 154, Color.FromArgb(198, 184, 255), Color.FromArgb(112, 91, 227));
        DrawBall(g, 166, 177, 104, Color.FromArgb(255, 207, 180), Color.FromArgb(233, 121, 123));
        DrawBall(g, 169, 291, 82, Color.FromArgb(166, 207, 255), Color.FromArgb(85, 142, 218));
        using (Pen orbit = new Pen(Color.FromArgb(105, 255, 255, 255), 2F))
            g.DrawArc(orbit, 82, 236, 120, 116, 202, 126);

        using (Font headline = new Font("Segoe UI", 18F, FontStyle.Bold))
        using (SolidBrush b = new SolidBrush(Ink)) g.DrawString("Ready for one\nmore round?", headline, b, 34, 402);
        using (Font sub = new Font("Segoe UI", 9.5F, FontStyle.Regular))
        using (SolidBrush b = new SolidBrush(Color.FromArgb(102, 98, 112)))
            g.DrawString("The game and its Node.js runtime\nare packed together.", sub, b, 36, 461);

        using (Pen line = new Pen(Color.FromArgb(223, 219, 235), 1F))
            g.DrawLine(line, 32, brand.Height - 48, brand.Width - 32, brand.Height - 48);
    }

    private static void DrawBall(Graphics g, float x, float y, float d, Color light, Color dark)
    {
        using (SolidBrush shadow = new SolidBrush(Color.FromArgb(24, 64, 48, 105)))
            g.FillEllipse(shadow, x + d * .09F, y + d * .88F, d * .82F, d * .18F);
        RectangleF r = new RectangleF(x, y, d, d);
        using (LinearGradientBrush b = new LinearGradientBrush(r, light, dark, 48F))
            g.FillEllipse(b, r);
        using (SolidBrush shine = new SolidBrush(Color.FromArgb(92, 255, 255, 255)))
            g.FillEllipse(shine, x + d * .19F, y + d * .12F, d * .28F, d * .13F);
        using (Pen rim = new Pen(Color.FromArgb(70, 255, 255, 255), Math.Max(1F, d * .012F)))
            g.DrawArc(rim, x + d * .06F, y + d * .05F, d * .88F, d * .88F, 205, 96);
    }

    private void ShowPage(int value)
    {
        page = value;
        foreach (Control c in content.Controls) c.Dispose();
        content.Controls.Clear();
        installing = value == 3;
        closeButton.Enabled = !installing;
        backButton.Visible = value == 1 || value == 2 || value == 5;
        nextButton.Visible = value != 3;
        nextButton.Enabled = true;
        nextButton.Text = value == 0 ? "Continue" : value == 1 ? "Continue" : value == 2 ? "Install" : value == 4 ? "Launch game" : "Try again";
        stepLabel.Text = value == 4 ? "COMPLETE" : value == 5 ? "INSTALLATION ISSUE" : "SETUP  ·  0" + (value + 1) + " / 05";
        brandStatus.Text = value == 4 ? "INSTALLATION COMPLETE" : value == 5 ? "PLEASE TRY AGAIN" : "STEP  0" + (value + 1) + "  /  05";
        progress.Width = value == 5 ? 0 : (int)((right.Width - 80) * Math.Min(.2F * (value + 1), 1F));

        if (value == 0) WelcomePage();
        else if (value == 1) LicensePage();
        else if (value == 2) LocationPage();
        else if (value == 3) InstallingPage();
        else if (value == 4) CompletePage();
        else FailurePage();
    }

    private void NextClicked(object sender, EventArgs e)
    {
        if (page == 0) ShowPage(1);
        else if (page == 1) ShowPage(2);
        else if (page == 2) { installPath = pathBox.Text; BeginInstall(); }
        else if (page == 4) LaunchGame();
        else if (page == 5) BeginInstall();
    }

    private void WelcomePage()
    {
        AddText("A LITTLE CHAOS. A LOT OF FUN.", 0, 4, 480, 20, 8.5F, true, Accent);
        AddText("Let's get you into\nthe arena.", 0, 39, 480, 91, 30F, true, Ink);
        AddText("Install once and jump straight into Bumper Brawl.\nNo separate Node.js setup is needed.",
            0, 147, 480, 48, 11F, false, Muted);
        AddInfoCard(0, 218, "01", "Everything included", "Game files and Node.js runtime in one setup.");
        AddInfoCard(0, 305, "02", "Ready from your desktop", "Adds Desktop and Start Menu shortcuts.");
    }

    private void LicensePage()
    {
        AddText("BEFORE YOU PLAY", 0, 4, 480, 20, 8.5F, true, Accent);
        AddText("License Agreement", 0, 39, 480, 48, 26F, true, Ink);
        AddText("Please review the license. You must accept it to continue.",
            0, 94, 480, 30, 10.5F, false, Muted);

        Panel frame = new Panel();
        frame.SetBounds(0, 135, content.Width - 2, 220);
        frame.BackColor = Color.FromArgb(250, 249, 252);
        frame.Padding = new Padding(12);
        frame.Paint += delegate(object s, PaintEventArgs e) {
            using (Pen p = new Pen(Color.FromArgb(231, 228, 237)))
                e.Graphics.DrawRectangle(p, 0, 0, frame.Width - 1, frame.Height - 1);
        };
        RichTextBox license = new RichTextBox();
        license.Dock = DockStyle.Fill;
        license.ReadOnly = true;
        license.BorderStyle = BorderStyle.None;
        license.BackColor = frame.BackColor;
        license.ForeColor = Color.FromArgb(69, 66, 75);
        license.Font = new Font("Consolas", 9F);
        license.DetectUrls = true;
        using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream("BumperBrawlLicense"))
        using (StreamReader reader = new StreamReader(s)) license.Text = reader.ReadToEnd();
        frame.Controls.Add(license);
        content.Controls.Add(frame);

        CheckBox accept = new CheckBox();
        accept.SetBounds(0, 371, content.Width - 5, 28);
        accept.Text = "I have read and accept the ISC License";
        accept.Font = new Font("Segoe UI", 9.5F, FontStyle.Regular);
        accept.ForeColor = Ink;
        accept.CheckedChanged += delegate { nextButton.Enabled = accept.Checked; };
        content.Controls.Add(accept);
        nextButton.Enabled = false;
    }

    private void LocationPage()
    {
        AddText("YOUR SETUP", 0, 4, 480, 20, 8.5F, true, Accent);
        AddText("Choose a location", 0, 39, 480, 48, 26F, true, Ink);
        AddText("Choose where Bumper Brawl should be installed.",
            0, 94, 480, 30, 10.5F, false, Muted);

        AddText("INSTALL FOLDER", 0, 157, 450, 18, 8F, true, Muted);
        pathBox = new TextBox();
        pathBox.SetBounds(0, 184, 386, 38);
        pathBox.BorderStyle = BorderStyle.FixedSingle;
        pathBox.Font = new Font("Segoe UI", 10F);
        pathBox.Text = String.IsNullOrWhiteSpace(installPath) ? DefaultInstallPath() : installPath;
        pathBox.AccessibleName = "Installation folder";
        content.Controls.Add(pathBox);

        ActionButton browse = new ActionButton(false);
        browse.SetBounds(397, 181, 107, 42);
        browse.Text = "Browse";
        browse.Click += delegate {
            using (FolderBrowserDialog dialog = new FolderBrowserDialog()) {
                dialog.Description = "Choose the Bumper Brawl installation folder.";
                dialog.ShowNewFolderButton = true;
                try { dialog.SelectedPath = PathBoxPath(pathBox.Text); } catch { }
                if (dialog.ShowDialog(this) == DialogResult.OK) pathBox.Text = dialog.SelectedPath;
            }
        };
        content.Controls.Add(browse);

        AddInfoCard(0, 255, "✓", "Runtime included", "Node.js is bundled. No separate install is needed.");
        AddText("Shortcuts for your Desktop and Start Menu will be created.",
            1, 353, content.Width - 2, 26, 9F, false, Muted);
    }

    private void InstallingPage()
    {
        AddText("PLEASE WAIT", 0, 7, 480, 20, 8.5F, true, Accent);
        AddText("Installing Bumper Brawl", 0, 43, 480, 48, 26F, true, Ink);
        AddText("Copying the game and bundled Node.js runtime.\nThis should only take a moment.",
            0, 101, 480, 48, 10.5F, false, Muted);

        ProgressBar bar = new ProgressBar();
        bar.SetBounds(0, 185, content.Width - 4, 5);
        bar.Style = ProgressBarStyle.Marquee;
        bar.MarqueeAnimationSpeed = 26;
        content.Controls.Add(bar);

        AddText(installPath, 0, 212, content.Width - 4, 46, 8.5F, false, Muted);
    }

    private void CompletePage()
    {
        AddText("ALL SET", 0, 7, 480, 20, 8.5F, true, Accent);
        Label check = AddText("✓", 0, 54, 64, 64, 34F, true, Color.FromArgb(66, 153, 116));
        AddText("You're all set.", 0, 130, 480, 49, 28F, true, Ink);
        AddText("Bumper Brawl is installed and ready.\nYour Desktop and Start Menu shortcuts are in place.",
            0, 190, 480, 53, 10.5F, false, Muted);
        AddInfoCard(0, 273, "↗", "Jump in now", "Launch the game directly from this window.");
        ActionButton done = new ActionButton(false);
        done.SetBounds(0, 365, 118, 38);
        done.Text = "Done";
        done.Click += delegate { Close(); };
        content.Controls.Add(done);
    }

    private void FailurePage()
    {
        AddText("INSTALLATION ISSUE", 0, 7, 480, 20, 8.5F, true, Color.FromArgb(194, 99, 89));
        AddText("We couldn't finish\nthe installation.", 0, 43, 480, 76, 25F, true, Ink);
        AddText("Check that you can write to the selected folder, then try again.",
            0, 135, 480, 44, 10.5F, false, Muted);
        AddText(installPath, 0, 207, content.Width - 5, 46, 8.5F, false, Muted);
    }

    private void AddInfoCard(int x, int y, string marker, string title, string detail)
    {
        Panel card = new Panel();
        card.SetBounds(x, y, content.Width - 2, 72);
        card.BackColor = Color.FromArgb(250, 249, 252);
        card.Paint += delegate(object s, PaintEventArgs e) {
            using (Pen p = new Pen(Color.FromArgb(239, 237, 243)))
                e.Graphics.DrawRectangle(p, 0, 0, card.Width - 1, card.Height - 1);
        };
        Label badge = new Label();
        badge.SetBounds(14, 16, 39, 39);
        badge.Text = marker;
        badge.TextAlign = ContentAlignment.MiddleCenter;
        badge.Font = new Font("Segoe UI", marker.Length > 1 ? 8F : 13F, FontStyle.Bold);
        badge.ForeColor = Accent;
        badge.BackColor = Color.FromArgb(239, 235, 255);
        card.Controls.Add(badge);
        Label titleLabel = new Label();
        titleLabel.SetBounds(67, 13, card.Width - 80, 22);
        titleLabel.Text = title;
        titleLabel.Font = new Font("Segoe UI", 9.5F, FontStyle.Bold);
        titleLabel.ForeColor = Ink;
        card.Controls.Add(titleLabel);
        Label detailLabel = new Label();
        detailLabel.SetBounds(67, 37, card.Width - 80, 22);
        detailLabel.Text = detail;
        detailLabel.Font = new Font("Segoe UI", 8.5F, FontStyle.Regular);
        detailLabel.ForeColor = Muted;
        card.Controls.Add(detailLabel);
        content.Controls.Add(card);
    }

    private Label AddText(string value, int x, int y, int width, int height, float size, bool bold, Color color)
    {
        Label l = new Label();
        l.SetBounds(x, y, width, height);
        l.Text = value;
        l.ForeColor = color;
        l.BackColor = Color.Transparent;
        l.Font = new Font("Segoe UI", size, bold ? FontStyle.Bold : FontStyle.Regular);
        l.AutoEllipsis = true;
        content.Controls.Add(l);
        return l;
    }

    private static string DefaultInstallPath()
    {
        try {
            using (RegistryKey key = Registry.CurrentUser.OpenSubKey("Software\\BumperBrawl")) {
                string previous = key == null ? null : key.GetValue("InstallDir") as string;
                if (!String.IsNullOrWhiteSpace(previous)) return previous;
            }
        } catch { }
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Programs", "Bumper Brawl");
    }

    private static string PathBoxPath(string value)
    {
        if (String.IsNullOrWhiteSpace(value)) return DefaultInstallPath();
        return Path.GetFullPath(value);
    }

    private void BeginInstall()
    {
        string destination;
        try {
            destination = Path.GetFullPath((installPath ?? DefaultInstallPath()).Trim());
            string root = Path.GetPathRoot(destination);
            if (String.Equals(destination.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar),
                root.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar), StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Choose a folder inside a drive, not the drive itself.");
            installPath = destination;
        } catch (Exception ex) {
            MessageBox.Show(this, "Choose a valid installation folder.\n\n" + ex.Message,
                "Bumper Brawl Setup", MessageBoxButtons.OK, MessageBoxIcon.Information);
            ShowPage(2);
            return;
        }

        ShowPage(3);
        ThreadPool.QueueUserWorkItem(delegate {
            int exitCode = -1;
            string failure = null;
            string tempFolder = Path.Combine(Path.GetTempPath(), "BumperBrawlSetup-" + Guid.NewGuid().ToString("N"));
            try {
                Directory.CreateDirectory(tempFolder);
                string corePath = Path.Combine(tempFolder, "BumperBrawlCore.exe");
                using (Stream source = Assembly.GetExecutingAssembly().GetManifestResourceStream("BumperBrawlCore"))
                using (FileStream target = new FileStream(corePath, FileMode.CreateNew, FileAccess.Write))
                    source.CopyTo(target);
                ProcessStartInfo info = new ProcessStartInfo();
                info.FileName = corePath;
                // NSIS requires /D= to be the final argument and parses the remainder as the path.
                info.Arguments = "/S /D=" + installPath;
                info.UseShellExecute = false;
                info.CreateNoWindow = true;
                info.WindowStyle = ProcessWindowStyle.Hidden;
                using (Process process = Process.Start(info)) {
                    process.WaitForExit();
                    exitCode = process.ExitCode;
                }
                if (exitCode != 0) failure = "The installer returned code " + exitCode + ".";
            } catch (Exception ex) { failure = ex.Message; }
            finally { try { if (Directory.Exists(tempFolder)) Directory.Delete(tempFolder, true); } catch { } }
            int result = exitCode;
            string message = failure;
            try {
                BeginInvoke((MethodInvoker)delegate {
                    if (IsDisposed) return;
                    if (result == 0) ShowPage(4);
                    else { ShowPage(5); if (!String.IsNullOrEmpty(message)) AddText(message, 0, 265, content.Width - 5, 48, 8.5F, false, Muted); }
                });
            } catch { }
        });
    }

    private void LaunchGame()
    {
        string batch = Path.Combine(installPath, "start.bat");
        if (!File.Exists(batch)) {
            MessageBox.Show(this, "The game launcher could not be found in the selected folder.",
                "Bumper Brawl", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }
        try {
            Process.Start(new ProcessStartInfo { FileName = batch, WorkingDirectory = installPath, UseShellExecute = true });
            Close();
        } catch (Exception ex) {
            MessageBox.Show(this, ex.Message, "Bumper Brawl", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }
}

internal sealed class ActionButton : Button
{
    private readonly bool primary;
    public ActionButton(bool isPrimary)
    {
        primary = isPrimary;
        FlatStyle = FlatStyle.Flat;
        FlatAppearance.BorderSize = 0;
        UseVisualStyleBackColor = false;
        Font = new Font("Segoe UI", 9.5F, FontStyle.Bold);
        Cursor = Cursors.Hand;
        TabStop = true;
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer, true);
    }
    protected override void OnPaint(PaintEventArgs e)
    {
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        Color fill = primary ? Color.FromArgb(103, 87, 222) : Color.FromArgb(245, 243, 249);
        Color text = primary ? Color.White : Color.FromArgb(57, 54, 64);
        if (!Enabled) { fill = Color.FromArgb(224, 221, 232); text = Color.FromArgb(145, 141, 151); }
        else if (ClientRectangle.Contains(PointToClient(MousePosition)))
            fill = primary ? Color.FromArgb(87, 70, 207) : Color.FromArgb(235, 232, 242);
        using (GraphicsPath path = RoundedRectangle(new Rectangle(0, 0, Width - 1, Height - 1), 8))
        using (SolidBrush b = new SolidBrush(fill)) e.Graphics.FillPath(b, path);
        TextRenderer.DrawText(e.Graphics, Text, Font, ClientRectangle, text,
            TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine);
        if (Focused && ShowFocusCues)
        {
            using (Pen focus = new Pen(primary ? Color.White : Color.FromArgb(103, 87, 222)))
                e.Graphics.DrawRectangle(focus, 4, 4, Width - 9, Height - 9);
        }
    }

    private static GraphicsPath RoundedRectangle(Rectangle r, int radius)
    {
        int d = radius * 2;
        GraphicsPath path = new GraphicsPath();
        path.AddArc(r.X, r.Y, d, d, 180, 90);
        path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        path.CloseFigure();
        return path;
    }
}
