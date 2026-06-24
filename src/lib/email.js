import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({
  host: "sandbox.smtp.mailtrap.io",
  port: 587,
  auth: {
    user: "5775db2765ccaf",
    pass: "53bc325c007402",
  },
});

/**
 * Sends a welcome email containing login credentials to the newly created user
 * @param {string} to - Recipient email address
 * @param {string} name - User's name
 * @param {string} username - User's login username
 * @param {string} password - User's plain-text password
 */
export const sendWelcomeEmail = async (to, name, username, password) => {
  const mailOptions = {
    from: '"Mostanad Platform" <no-reply@mostanad.com>',
    to: to,
    subject: "Welcome to Mostanad - Your Login Credentials",
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 8px;">
        <h2 style="color: #2c3e50; text-align: center;">Welcome to Mostanad!</h2>
        <p>Hello <strong>${name}</strong>,</p>
        <p>Your administrator account has been successfully created. Below are your login credentials to access the platform:</p>
        
        <div style="background-color: #f8f9fa; padding: 15px; border-radius: 6px; margin: 20px 0; border-left: 4px solid #3498db;">
          <table style="width: 100%;">
            <tr>
              <td style="font-weight: bold; width: 100px;">Username:</td>
              <td>${username}</td>
            </tr>
            <tr>
              <td style="font-weight: bold; width: 100px;">Email:</td>
              <td>${to}</td>
            </tr>
            <tr>
              <td style="font-weight: bold; width: 100px;">Password:</td>
              <td><code style="background-color: #e8e8e8; padding: 2px 6px; border-radius: 4px; font-size: 1.1em;">${password}</code></td>
            </tr>
          </table>
        </div>
        
        <p>For security reasons, we strongly recommend that you log in and change your password immediately.</p>
        <p style="margin-top: 30px;">Best regards,<br><strong>Mostanad Team</strong></p>
      </div>
    `,
  };

  try {
    console.log(`[EmailService] Sending welcome email to ${to}...`);
    const info = await transporter.sendMail(mailOptions);
    console.log(`[EmailService] Email sent successfully: ${info.messageId}`);
    return info;
  } catch (error) {
    console.error(`[EmailService] Failed to send welcome email:`, error);
    throw error;
  }
};
